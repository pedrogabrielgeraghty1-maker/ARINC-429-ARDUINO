const $ = (selector) => document.querySelector(selector);
const instrumentForm = $('#instrument-form');
const frameForm = $('#frame-form');
const instrumentList = $('#instrument-list');
const historyList = $('#history-list');
const binaryWord = $('#binary-word');
const previewState = $('#preview-state');
const sendFrameButton = $('#send-frame');
let instruments = [];
let previewTimer;
let previewRequest = 0;
let toastTimer;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'No se pudo completar la solicitud.');
  return result;
}

function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function loadInstruments() {
  instruments = await api('/api/instrumentos');
  $('#instrument-count').textContent = `${instruments.length} ${instruments.length === 1 ? 'registrado' : 'registrados'}`;
  if (!instruments.length) {
    instrumentList.innerHTML = '<tr><td colspan="4" class="empty">Aún no hay instrumentos registrados.</td></tr>';
  } else {
    instrumentList.innerHTML = instruments.map((instrument) => `
      <tr>
        <td><strong>${escapeHtml(instrument.nombre_instrumento)}</strong></td>
        <td>${escapeHtml(instrument.agregado_por)}</td>
        <td>${escapeHtml(instrument.descripcion || '—')}</td>
        <td><div class="row-actions">
          <button class="button button-quiet button-small" data-edit="${instrument.id}" type="button">Editar</button>
          <button class="button button-quiet button-small button-danger" data-delete="${instrument.id}" type="button">Eliminar</button>
        </div></td>
      </tr>`).join('');
  }

  const selected = $('#frame-instrument').value;
  $('#frame-instrument').innerHTML = '<option value="">Selecciona un instrumento</option>' +
    instruments.map((instrument) =>
      `<option value="${instrument.id}">${escapeHtml(instrument.nombre_instrumento)}</option>`,
    ).join('');
  if (instruments.some((instrument) => String(instrument.id) === selected)) {
    $('#frame-instrument').value = selected;
  }
  sendFrameButton.disabled = instruments.length === 0 || !previewIsValid();
}

async function loadHistory() {
  const history = await api('/api/historial?limit=500');
  if (!history.length) {
    historyList.innerHTML = '<tr><td colspan="5" class="empty">No hay transmisiones registradas.</td></tr>';
    return;
  }
  historyList.innerHTML = history.map((entry) => `
    <tr>
      <td>#${escapeHtml(entry.id)}</td>
      <td><strong>${escapeHtml(entry.nombre_instrumento)}</strong></td>
      <td>${escapeHtml(entry.valor_dato)}</td>
      <td class="binary-cell">${escapeHtml(entry.palabra_binaria)}</td>
      <td>${entry.palabra_binaria[0] === '1' ? 'HIGH' : 'LOW'} ·
        ${escapeHtml(entry.tension_a_b)} / ${escapeHtml(entry.tension_a)} / ${escapeHtml(entry.tension_b)} V</td>
    </tr>`).join('');
}

function resetInstrumentForm() {
  instrumentForm.reset();
  $('#instrument-id').value = '';
  $('#instrument-submit').textContent = 'Agregar instrumento';
  $('#instrument-cancel').classList.add('hidden');
}

instrumentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#instrument-id').value;
  const body = {
    nombre_instrumento: $('#instrument-name').value,
    agregado_por: $('#instrument-operator').value,
    descripcion: $('#instrument-description').value,
  };
  try {
    await api(id ? `/api/instrumentos/${id}` : '/api/instrumentos', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    });
    resetInstrumentForm();
    await loadInstruments();
    showToast(id ? 'Instrumento actualizado.' : 'Instrumento agregado.');
  } catch (error) {
    showToast(error.message, true);
  }
});

instrumentList.addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit]');
  const deleteButton = event.target.closest('[data-delete]');
  if (editButton) {
    const instrument = instruments.find((item) => item.id === Number(editButton.dataset.edit));
    if (!instrument) return;
    $('#instrument-id').value = instrument.id;
    $('#instrument-name').value = instrument.nombre_instrumento;
    $('#instrument-operator').value = instrument.agregado_por;
    $('#instrument-description').value = instrument.descripcion || '';
    $('#instrument-submit').textContent = 'Guardar cambios';
    $('#instrument-cancel').classList.remove('hidden');
    $('#instrument-name').focus();
  }
  if (deleteButton) {
    const instrument = instruments.find((item) => item.id === Number(deleteButton.dataset.delete));
    if (!instrument || !window.confirm(`¿Eliminar "${instrument.nombre_instrumento}"?`)) return;
    try {
      await api(`/api/instrumentos/${instrument.id}`, { method: 'DELETE' });
      await Promise.all([loadInstruments(), loadHistory()]);
      showToast('Instrumento eliminado.');
    } catch (error) {
      showToast(error.message, true);
    }
  }
});

$('#instrument-cancel').addEventListener('click', resetInstrumentForm);

function framePreviewPayload() {
  const value = $('#frame-value').value;
  if (!$('#frame-instrument').value || value === '' || !Number.isFinite(Number(value))) return null;
  return { valor_dato: Number(value) };
}

function resetVoltagePreview() {
  $('#voltage-ab').textContent = '—';
  $('#voltage-agnd').textContent = '—';
  $('#voltage-bgnd').textContent = '—';
  $('#voltage-state').textContent = 'En espera';
}

let previewIsValid = () => binaryWord.dataset.valid === 'true';

async function updatePreview() {
  const requestId = ++previewRequest;
  const payload = framePreviewPayload();
  if (!payload) {
    binaryWord.dataset.valid = 'false';
    binaryWord.textContent = '00000000 00000000 00000000 00000000';
    previewState.textContent = 'Completa los campos';
    sendFrameButton.disabled = true;
    resetVoltagePreview();
    return;
  }

  previewState.textContent = 'Calculando…';
  sendFrameButton.disabled = true;
  try {
    const result = await api('/api/tramas/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (requestId !== previewRequest) return;
    binaryWord.textContent = result.palabra_binaria.match(/.{1,8}/g).join(' ');
    $('#voltage-ab').textContent = `${result.tension_a_b > 0 ? '+' : ''}${result.tension_a_b.toFixed(1)} V`;
    $('#voltage-agnd').textContent = `${result.tension_a > 0 ? '+' : ''}${result.tension_a.toFixed(1)} V`;
    $('#voltage-bgnd').textContent = `${result.tension_b > 0 ? '+' : '−'}${Math.abs(result.tension_b).toFixed(1)} V`;
    $('#voltage-state').textContent = `${result.estado_linea} · bit ${result.bit_ultimo_transmitido}`;
    binaryWord.dataset.valid = 'true';
    previewState.textContent = `Paridad impar · escala ${result.resolucion_dato}`;
    sendFrameButton.disabled = !$('#frame-instrument').value;
  } catch (error) {
    if (requestId !== previewRequest) return;
    binaryWord.dataset.valid = 'false';
    binaryWord.textContent = '00000000 00000000 00000000 00000000';
    previewState.textContent = error.message;
    sendFrameButton.disabled = true;
    resetVoltagePreview();
  }
}

frameForm.addEventListener('input', () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 140);
});
frameForm.addEventListener('change', updatePreview);

frameForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    instrumento_id: Number($('#frame-instrument').value),
    ...framePreviewPayload(),
  };
  if (!frameForm.reportValidity()) return;
  sendFrameButton.disabled = true;
  try {
    const saved = await api('/api/tramas', { method: 'POST', body: JSON.stringify(payload) });
    binaryWord.textContent = saved.palabra_binaria.match(/.{1,8}/g).join(' ');
    await loadHistory();
    showToast('Transmisión registrada en el historial.');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    sendFrameButton.disabled = !$('#frame-instrument').value || !previewIsValid();
  }
});

$('#frame-instrument').addEventListener('change', () => {
  sendFrameButton.disabled = !$('#frame-instrument').value || !previewIsValid();
});
$('#refresh-history').addEventListener('click', () => {
  loadHistory().catch((error) => showToast(error.message, true));
});

Promise.all([loadInstruments(), loadHistory(), updatePreview()]).catch((error) => {
  showToast(error.message, true);
});

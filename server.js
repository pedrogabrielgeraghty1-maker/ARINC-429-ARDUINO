require('dotenv').config();

const express = require('express');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { encodeArinc429, parseLabel, parseTwoBitField } = require('./src/arinc429');

const app = express();
const port = Number(process.env.PORT || 3000);
const dataResolution = Number(process.env.ARINC_DATA_RESOLUTION || 1);
const labelOctal = process.env.ARINC_LABEL_OCTAL || '203';
const sdi = process.env.ARINC_SDI || '00';
const ssm = process.env.ARINC_SSM || '00';

if (!Number.isFinite(dataResolution) || dataResolution <= 0) {
  throw new Error('ARINC_DATA_RESOLUTION debe ser un número mayor que cero.');
}
parseLabel(labelOctal);
parseTwoBitField(sdi, 'SDI');
parseTwoBitField(ssm, 'SSM');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ARINC_429_Arduino',
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function positiveId(rawId) {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new TypeError('El identificador debe ser un entero positivo.');
    error.status = 400;
    throw error;
  }
  return id;
}

function requiredText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new TypeError(`${field} es obligatorio.`);
    error.status = 400;
    throw error;
  }
  const text = value.trim();
  if (text.length > maxLength) {
    const error = new RangeError(`${field} no puede superar ${maxLength} caracteres.`);
    error.status = 400;
    throw error;
  }
  return text;
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength) {
    const error = new TypeError(`${field} debe ser texto de hasta ${maxLength} caracteres.`);
    error.status = 400;
    throw error;
  }
  return value.trim();
}

function requiredNumber(value, field) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) {
    const error = new TypeError(`${field} debe ser un número finito.`);
    error.status = 400;
    throw error;
  }
  return Number(value);
}

function validateInstrument(body) {
  return {
    nombre_instrumento: requiredText(body.nombre_instrumento, 'El nombre del instrumento', 150),
    agregado_por: requiredText(body.agregado_por, 'El nombre del operador', 120),
    descripcion: optionalText(body.descripcion, 'La descripción', 5000),
  };
}

function validateFrame(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new TypeError('El cuerpo debe ser un objeto JSON con instrumento_id y valor_dato.');
    error.status = 400;
    throw error;
  }
  return {
    instrumento_id: positiveId(body.instrumento_id),
    valor_dato: requiredNumber(body.valor_dato, 'El valor del dato'),
  };
}

function calculateFrame(value) {
  return encodeArinc429(value, {
    label_octal: labelOctal,
    sdi,
    ssm,
    resolution: dataResolution,
  });
}

function serializeHistoryRows(rows) {
  return rows.map((row) => ({
    ...row,
    palabra_32bits: String(row.palabra_32bits),
    palabra_binaria: BigInt(row.palabra_32bits).toString(2).padStart(32, '0'),
  }));
}

app.get('/api/instrumentos', asyncHandler(async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT id, nombre_instrumento, agregado_por, descripcion, creado_en, actualizado_en
     FROM envios ORDER BY creado_en DESC, id DESC`,
  );
  res.json(rows);
}));

app.get('/api/instrumentos/:id', asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT id, nombre_instrumento, agregado_por, descripcion, creado_en, actualizado_en
     FROM envios WHERE id = ?`,
    [positiveId(req.params.id)],
  );
  if (!rows.length) return res.status(404).json({ error: 'Instrumento no encontrado.' });
  res.json(rows[0]);
}));

app.post('/api/instrumentos', asyncHandler(async (req, res) => {
  const instrument = validateInstrument(req.body);
  const [result] = await pool.execute(
    `INSERT INTO envios (nombre_instrumento, agregado_por, descripcion) VALUES (?, ?, ?)`,
    [instrument.nombre_instrumento, instrument.agregado_por, instrument.descripcion],
  );
  const [rows] = await pool.execute('SELECT * FROM envios WHERE id = ?', [result.insertId]);
  res.status(201).json(rows[0]);
}));

app.put('/api/instrumentos/:id', asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id);
  const instrument = validateInstrument(req.body);
  const [result] = await pool.execute(
    `UPDATE envios
     SET nombre_instrumento = ?, agregado_por = ?, descripcion = ?
     WHERE id = ?`,
    [instrument.nombre_instrumento, instrument.agregado_por, instrument.descripcion, id],
  );
  if (result.affectedRows === 0) {
    const [existing] = await pool.execute('SELECT id FROM envios WHERE id = ?', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Instrumento no encontrado.' });
  }
  const [rows] = await pool.execute('SELECT * FROM envios WHERE id = ?', [id]);
  res.json(rows[0]);
}));

app.delete('/api/instrumentos/:id', asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id);
  const [existing] = await pool.execute('SELECT id FROM envios WHERE id = ?', [id]);
  if (!existing.length) return res.status(404).json({ error: 'Instrumento no encontrado.' });
  const [history] = await pool.execute(
    'SELECT id FROM historial_envios WHERE instrumento_id = ? LIMIT 1',
    [id],
  );
  if (history.length) {
    return res.status(409).json({
      error: 'No se puede eliminar el instrumento porque tiene transmisiones en el historial.',
    });
  }
  const [result] = await pool.execute('DELETE FROM envios WHERE id = ?', [id]);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Instrumento no encontrado.' });
  res.status(204).end();
}));

app.post('/api/tramas/preview', asyncHandler(async (req, res) => {
  const encoded = calculateFrame(req.body);
  res.json({
    palabra_32bits: encoded.palabra_32bits.toString(),
    palabra_binaria: encoded.palabra_binaria,
    resolucion_dato: dataResolution,
    bit_ultimo_transmitido: encoded.bit_ultimo_transmitido,
    estado_linea: encoded.estado_linea,
    tension_a_b: encoded.tension_a_b,
    tension_a: encoded.tension_a,
    tension_b: encoded.tension_b,
  });
}));

app.get('/api/historial', asyncHandler(async (req, res) => {
  const requestedLimit = Number(req.query.limit || 100);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) {
    return res.status(400).json({ error: 'limit debe ser un entero entre 1 y 500.' });
  }
  const [rows] = await pool.execute(
    `SELECT h.id, h.instrumento_id, e.nombre_instrumento, h.valor_dato,
            h.palabra_32bits, h.tension_a, h.tension_b, h.tension_a_b
     FROM historial_envios h
     INNER JOIN envios e ON e.id = h.instrumento_id
     ORDER BY h.id DESC LIMIT ?`,
    [requestedLimit],
  );
  res.json(serializeHistoryRows(rows));
}));

app.post('/api/tramas', asyncHandler(async (req, res) => {
  try {
    const frame = validateFrame(req.body);
    const encoded = calculateFrame(frame);
    const [instrument] = await pool.execute('SELECT id FROM envios WHERE id = ?', [frame.instrumento_id]);
    if (!instrument.length) return res.status(404).json({ error: 'Instrumento no encontrado.' });

    const [result] = await pool.execute(
      `INSERT INTO historial_envios
         (instrumento_id, valor_dato, palabra_32bits, tension_a, tension_b, tension_a_b)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        frame.instrumento_id,
        frame.valor_dato,
        encoded.palabra_32bits.toString(),
        encoded.tension_a,
        encoded.tension_b,
        encoded.tension_a_b,
      ],
    );
    const [rows] = await pool.execute(
      `SELECT h.id, h.instrumento_id, e.nombre_instrumento, h.valor_dato,
              h.palabra_32bits, h.tension_a, h.tension_b, h.tension_a_b
       FROM historial_envios h
       INNER JOIN envios e ON e.id = h.instrumento_id
       WHERE h.id = ?`,
      [result.insertId],
    );
    res.status(201).json(serializeHistoryRows(rows)[0]);
  } catch (err) {
    console.error('Error al registrar la transmisión en historial_envios:', err);
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'No se pudo registrar la transmisión.' });
  }
}));

app.use((error, _req, res, _next) => {
  if (error.code === 'ER_ROW_IS_REFERENCED_2') {
    return res.status(409).json({
      error: 'No se puede eliminar el instrumento porque tiene transmisiones en el historial.',
    });
  }
  if (error.code === 'ER_NO_REFERENCED_ROW_2') {
    return res.status(404).json({ error: 'Instrumento no encontrado.' });
  }
  const status = error.status || (
    error instanceof TypeError || error instanceof RangeError ? 400 : 500
  );
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status === 500 ? 'Error interno del servidor.' : error.message });
});

const server = app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

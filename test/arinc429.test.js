const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateLastBitVoltages, encodeArinc429 } = require('../src/arinc429');

const config = {
  label_octal: '203',
  sdi: '00',
  ssm: '00',
  resolution: 1,
};

function countOnes(binary) {
  return [...binary].filter((bit) => bit === '1').length;
}

test('empaqueta label octal con los bits invertidos y paridad impar', () => {
  const result = encodeArinc429({
    valor_dato: 0,
  }, config);

  assert.equal(result.palabra_binaria.length, 32);
  assert.equal(result.palabra_binaria.slice(24, 32), '11000001');
  assert.equal(countOnes(result.palabra_binaria) % 2, 1);
  assert.equal(result.bit_ultimo_transmitido, Number(result.palabra_binaria[0]));
  assert.equal(result.estado_linea, result.bit_ultimo_transmitido ? 'HIGH' : 'LOW');
});

test('empaqueta campos SDI, BNR firmado y SSM', () => {
  const result = encodeArinc429({
    valor_dato: -1,
  }, { ...config, sdi: '10', ssm: '01' });
  const word = BigInt(result.palabra_32bits);

  assert.equal((word >> 8n) & 3n, 2n);
  assert.equal((word >> 10n) & ((1n << 19n) - 1n), (1n << 19n) - 1n);
  assert.equal((word >> 29n) & 3n, 1n);
  assert.equal(countOnes(result.palabra_binaria) % 2, 1);
});

test('rechaza valores fuera del rango firmado de 19 bits', () => {
  assert.throws(() => encodeArinc429({
    valor_dato: 262144,
  }, config), /entre -262144 y 262143/);
});

test('aplica la resolución configurada al dato', () => {
  const result = encodeArinc429({
    valor_dato: 12.3,
  }, { ...config, resolution: 0.1 });
  const data = (BigInt(result.palabra_32bits) >> 10n) & ((1n << 19n) - 1n);

  assert.equal(data, 123n);
});

test('usa Label 203, SDI 00 y SSM 00 cuando no se pasa configuración', () => {
  const result = encodeArinc429({ valor_dato: 0 });
  const word = BigInt(result.palabra_32bits);

  assert.equal(result.palabra_binaria.length, 32);
  assert.match(result.palabra_binaria, /^[01]{32}$/);
  assert.equal(word & 0xffn, 0xc1n);
  assert.equal((word >> 8n) & 3n, 0n);
  assert.equal((word >> 29n) & 3n, 0n);
});

test('codifica los límites de 19 bits en complemento a dos sin pérdida', () => {
  const minimum = encodeArinc429({ valor_dato: -262144 }, config);
  const maximum = encodeArinc429({ valor_dato: 262143 }, config);
  const dataMask = (1n << 19n) - 1n;

  assert.equal((BigInt(minimum.palabra_32bits) >> 10n) & dataMask, 1n << 18n);
  assert.equal((BigInt(maximum.palabra_32bits) >> 10n) & dataMask, dataMask >> 1n);
});

test('redondea escalas decimales usando aritmética decimal exacta', () => {
  const result = encodeArinc429({ valor_dato: 0.3 }, { ...config, resolution: 0.1 });
  const data = (BigInt(result.palabra_32bits) >> 10n) & ((1n << 19n) - 1n);

  assert.equal(data, 3n);
});

test('redondea empates decimales alejándose de cero', () => {
  const positive = encodeArinc429({ valor_dato: 0.5 }, config);
  const negative = encodeArinc429({ valor_dato: -0.5 }, config);
  const dataMask = (1n << 19n) - 1n;

  assert.equal((BigInt(positive.palabra_32bits) >> 10n) & dataMask, 1n);
  assert.equal((BigInt(negative.palabra_32bits) >> 10n) & dataMask, dataMask);
});

test('el bit de paridad se ajusta para que los 32 bits tengan cantidad impar de unos', () => {
  for (const valor_dato of [-262144, -1, 0, 1, 262143]) {
    const result = encodeArinc429({ valor_dato }, config);
    assert.equal(result.palabra_binaria.length, 32);
    assert.equal((result.palabra_binaria.split('1').length - 1) & 1, 1);
    assert.equal(BigInt(`0b${result.palabra_binaria}`), result.palabra_32bits);
  }
});

test('rechaza valores no numéricos y resoluciones inválidas', () => {
  assert.throws(() => encodeArinc429({ valor_dato: '12' }, config), /debe ser numérico/);
  assert.throws(() => encodeArinc429({ valor_dato: 12 }, { ...config, resolution: 0 }), /resolución/);
});

test('calcula tensiones diferenciales para el bit HIGH final', () => {
  assert.deepEqual(calculateLastBitVoltages(1n << 31n), {
    bit_ultimo_transmitido: 1,
    estado_linea: 'HIGH',
    tension_a_b: 20,
    tension_a: 10,
    tension_b: -10,
  });
});

test('calcula tensiones diferenciales para el bit LOW final', () => {
  assert.deepEqual(calculateLastBitVoltages(0n), {
    bit_ultimo_transmitido: 0,
    estado_linea: 'LOW',
    tension_a_b: -20,
    tension_a: -10,
    tension_b: 10,
  });
});

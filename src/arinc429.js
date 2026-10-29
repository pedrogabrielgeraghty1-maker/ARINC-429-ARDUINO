const LABEL_MAX = 0xff;
const DATA_WIDTH = 19;
const DATA_MIN = -(1n << BigInt(DATA_WIDTH - 1));
const DATA_MAX = (1n << BigInt(DATA_WIDTH - 1)) - 1n;
const WORD_MASK = (1n << 32n) - 1n;

function reverseByte(value) {
  let reversed = 0;
  for (let bit = 0; bit < 8; bit += 1) {
    reversed = (reversed << 1) | ((value >> bit) & 1);
  }
  return reversed;
}

function parseLabel(label) {
  if (typeof label !== 'string' || !/^[0-7]{1,3}$/.test(label)) {
    throw new TypeError('El label debe ser una cadena octal de 1 a 3 dígitos.');
  }

  const value = Number.parseInt(label, 8);
  if (value > LABEL_MAX) {
    throw new RangeError('El label octal debe estar entre 000 y 377.');
  }
  return value;
}

function parseTwoBitField(value, name) {
  if (typeof value !== 'string' || !/^[01]{2}$/.test(value)) {
    throw new TypeError(`${name} debe contener exactamente dos bits (00, 01, 10 o 11).`);
  }
  return Number.parseInt(value, 2);
}

function decimalFraction(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} debe ser un número finito.`);
  }

  const match = /^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (!match) {
    throw new TypeError(`${name} no tiene una representación decimal válida.`);
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const fractionDigits = match[3] || '';
  const exponent = Number(match[4] || 0);
  let numerator = sign * BigInt(`${match[2]}${fractionDigits}`);
  const decimalPlaces = fractionDigits.length - exponent;

  if (decimalPlaces < 0) {
    numerator *= 10n ** BigInt(-decimalPlaces);
    return { numerator, denominator: 1n };
  }
  return { numerator, denominator: 10n ** BigInt(decimalPlaces) };
}

function scaleToInteger(value, resolution) {
  const valueFraction = decimalFraction(value, 'El valor del dato');
  const resolutionFraction = decimalFraction(resolution, 'La resolución ARINC');
  const numerator = valueFraction.numerator * resolutionFraction.denominator;
  const denominator = valueFraction.denominator * resolutionFraction.numerator;
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  let rounded = magnitude / denominator;

  if ((magnitude % denominator) * 2n >= denominator) {
    rounded += 1n;
  }
  return negative ? -rounded : rounded;
}

function calculateLastBitVoltages(word) {
  const parityBit = Number((word >> 31n) & 1n);
  const isHigh = parityBit === 1;
  const lineA = isHigh ? 10 : -10;
  const lineB = -lineA;

  return {
    bit_ultimo_transmitido: parityBit,
    estado_linea: isHigh ? 'HIGH' : 'LOW',
    tension_a_b: lineA - lineB,
    tension_a: lineA,
    tension_b: lineB,
  };
}

function encodeArinc429(
  { valor_dato },
  { label_octal = '203', sdi = '00', ssm = '00', resolution = 1 } = {},
) {
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new RangeError('La resolución ARINC debe ser un número mayor que cero.');
  }
  if (typeof valor_dato !== 'number' || !Number.isFinite(valor_dato)) {
    throw new TypeError('El valor del dato debe ser numérico y finito.');
  }

  const label = reverseByte(parseLabel(label_octal));
  const sourceDestination = parseTwoBitField(sdi, 'SDI');
  const signStatus = parseTwoBitField(ssm, 'SSM');
  const scaledData = scaleToInteger(valor_dato, resolution);

  if (scaledData < DATA_MIN || scaledData > DATA_MAX) {
    throw new RangeError(
      `El valor escalado debe estar entre ${DATA_MIN} y ${DATA_MAX} cuentas BNR.`,
    );
  }

  const dataField = BigInt.asUintN(DATA_WIDTH, scaledData);
  let word =
    BigInt(label) |
    (BigInt(sourceDestination) << 8n) |
    (dataField << 10n) |
    (BigInt(signStatus) << 29n);

  let ones = 0;
  for (let bit = 0; bit < 31; bit += 1) {
    ones += Number((word >> BigInt(bit)) & 1n);
  }
  if (ones % 2 === 0) {
    word |= 1n << 31n;
  }

  word &= WORD_MASK;
  const binaryWord = word.toString(2).padStart(32, '0');
  if (binaryWord.length !== 32) {
    throw new Error('La palabra ARINC calculada no tiene exactamente 32 bits.');
  }

  return {
    palabra_32bits: word,
    palabra_binaria: binaryWord,
    ...calculateLastBitVoltages(word),
  };
}

module.exports = {
  calculateLastBitVoltages,
  encodeArinc429,
  parseLabel,
  parseTwoBitField,
};

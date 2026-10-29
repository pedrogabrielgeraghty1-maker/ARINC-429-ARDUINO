# Simulador web ARINC 429

Aplicación con Node.js, Express y MySQL para gestionar instrumentos y registrar las transmisiones simuladas. El navegador pide al backend una vista previa de la palabra y el servidor vuelve a calcularla antes de guardar el historial; la palabra no se acepta como dato de entrada.

## Requisitos

- Node.js 18 o superior
- MySQL con la base `ARINC_429_Arduino` y las tablas `envios` e `historial_envios` ya creadas

## Inicio

1. Instala dependencias con `npm install`.
2. Copia `.env.example` a `.env` y configura la conexión MySQL.
3. Inicia el servidor con `npm start` (o `npm run dev` durante desarrollo).
4. Abre `http://localhost:3000`.

El usuario de MySQL necesita permisos de lectura, inserción, actualización y eliminación en las tablas indicadas. El servidor no crea ni modifica el esquema de base de datos.

## Convención de codificación implementada

El paquete `src/arinc429.js` construye la palabra de 32 bits con esta convención de simulación:

| Bits ARINC | Contenido |
|---|---|
| 1–8 | Label octal, con los ocho bits invertidos para el orden de transmisión ARINC |
| 9–10 | SDI |
| 11–29 | Campo de datos BNR con signo en complemento a dos de 19 bits |
| 30–31 | SSM |
| 32 | Paridad impar |

`ARINC_DATA_RESOLUTION` especifica unidades de valor por cuenta del campo BNR y por defecto vale `1`. El dato se transforma en cuentas con aritmética decimal entera y redondeo al entero más cercano (los empates se alejan de cero), evitando truncamientos al empaquetar los bits. El rango admitido es de -262144 a 262143 cuentas; por ejemplo, con resolución `0.1`, un valor de `12.3` se codifica como 123. Los campos se ensamblan con `BigInt`, y la palabra devuelta tiene siempre 32 caracteres binarios y una representación entera sin signo exacta para guardar en la base de datos. La paridad se cuenta explícitamente sobre los primeros 31 bits y se ajusta en el bit 32 para que el total de unos sea impar.

Para que el operador solo tenga que seleccionar el instrumento e indicar el valor, el backend toma Label, SDI y SSM de la configuración del servidor. Sus valores predeterminados son `203`, `00` y `00`; se pueden ajustar con `ARINC_LABEL_OCTAL`, `ARINC_SDI` y `ARINC_SSM` en `.env`. La escala se configura con `ARINC_DATA_RESOLUTION`. Los valores no numéricos, infinitos o fuera del rango representable se rechazan; no se genera una palabra inválida. El SSM predeterminado `00` representa el estado configurado para la transmisión. `10` indica estado de fallo/advertencia y no se asigna automáticamente a un valor numérico inválido.

Las tensiones registradas representan el **último bit transmitido**, que es el bit de paridad 32. Si vale 1 (HIGH), el modelo nominal usa A = +10 V, B = -10 V y A-B = +20 V; si vale 0 (LOW), usa A = -10 V, B = +10 V y A-B = -20 V. Son niveles nominales calculados a partir de la trama, no mediciones de hardware. El registro escribe `instrumento_id`, `valor_dato`, `palabra_32bits`, `tension_a`, `tension_b` y `tension_a_b`; estas columnas escalares no almacenan la forma de onda de los 32 bits ni el intervalo NULL entre palabras.

La codificación BNR, escala, SSM y la interpretación del label pueden depender de la definición concreta de cada etiqueta y del equipo. Verifica y ajusta estos parámetros al integrarla con equipos ARINC reales.

## API REST

| Método | Ruta | Acción |
|---|---|---|
| `GET` | `/api/instrumentos` | Lista instrumentos |
| `GET` | `/api/instrumentos/:id` | Consulta un instrumento |
| `POST` | `/api/instrumentos` | Crea un instrumento |
| `PUT` | `/api/instrumentos/:id` | Actualiza un instrumento |
| `DELETE` | `/api/instrumentos/:id` | Elimina un instrumento sin historial asociado |
| `POST` | `/api/tramas/preview` | Calcula la palabra sin guardarla |
| `GET` | `/api/historial?limit=100` | Lista transmisiones recientes (máximo 500) |
| `POST` | `/api/tramas` | Calcula y registra una transmisión y sus tensiones |

Ejemplo de `POST /api/tramas`:

```json
{
  "instrumento_id": 1,
  "valor_dato": 12.3
}
```

La API calcula label, SDI, SSM, paridad y tensiones en el servidor; no acepta esos valores del operador. Devuelve `palabra_32bits` como cadena decimal para conservar los 32 bits sin pérdida en JavaScript, `palabra_binaria` de 32 caracteres y los niveles nominales derivados del bit final.

## Pruebas

Ejecuta `npm test` para verificar el empaquetado, la inversión del label, el signo BNR, la resolución y la paridad impar.

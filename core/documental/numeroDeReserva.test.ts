import test from "node:test";
import assert from "node:assert/strict";
import { numeroDeReservaEnTexto } from "./numeroDeReserva";

test("caso real Guadalajara: «Número de reserva» con salto de línea y teléfono a continuación", () => {
  const texto = "*Datos de la reserva*\r\nNúmero de reserva\r\n5773032811 <(577)%20303-2811>\r\nNombre del alojamiento\r\nHotel Plaza Diana";
  assert.equal(numeroDeReservaEnTexto(texto), "5773032811");
});

test("formatos en inglés y con markdown o dos puntos", () => {
  assert.equal(numeroDeReservaEnTexto("- **Booking number:** 6188872919"), "6188872919");
  assert.equal(numeroDeReservaEnTexto("Confirmation: **5580815125**"), "5580815125");
  assert.equal(numeroDeReservaEnTexto("Your confirmation 5580815125"), undefined); // sin «number» ni dos puntos no es una etiqueta
  assert.equal(numeroDeReservaEnTexto("Confirmation number 5580815125"), "5580815125");
  assert.equal(numeroDeReservaEnTexto("Booking Number: 16455954864364072685"), "16455954864364072685");
  assert.equal(numeroDeReservaEnTexto("Localizador: 123456789"), "123456789");
});

test("el mismo número repetido cuenta una vez; dos reservas distintas no eligen ninguna", () => {
  assert.equal(numeroDeReservaEnTexto("Número de reserva 5773032811 ... Número de reserva 5773032811"), "5773032811");
  assert.equal(numeroDeReservaEnTexto("Número de reserva 5773032811 y Número de reserva 6188872919"), undefined);
});

test("números cortos, sin etiqueta o textos vacíos no producen nada", () => {
  assert.equal(numeroDeReservaEnTexto("Número de reserva 12345"), undefined);
  assert.equal(numeroDeReservaEnTexto("Teléfono 5773032811"), undefined);
  assert.equal(numeroDeReservaEnTexto(""), undefined);
  assert.equal(numeroDeReservaEnTexto(undefined), undefined);
});

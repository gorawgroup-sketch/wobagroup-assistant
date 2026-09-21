import test from "node:test";
import assert from "node:assert/strict";
import { destinoProveedorUber, seleccionarContactoUber, seleccionarContactoUberEats } from "./proveedorUber";
const contactos = [{id:"co", name:"UBER COLOMBIA"}, {id:"es", name:"UBER SYSTEMS SPAIN SL."},
  {id:"mx", name:"Uber México"}, {id:"cr", name:"UBER COSTA RICA"}, {id:"u", name:"Uber"}];
test("uses receipt route, not issuer country or card currency", () => {
  assert.equal(seleccionarContactoUber(contactos,"Uber Systems Spain SL.","Trayecto Bogotá — Colombia, 12 km; cobrado en EUR")?.id,"co");
  assert.equal(seleccionarContactoUber(contactos,"Uber","Trayecto Ciudad de México, 4 km")?.id,"mx");
  assert.equal(seleccionarContactoUber(contactos,"Uber","Trayecto Madrid, 4 km")?.id,"es");
});
test("unknown and conflicting country use country-free Uber", () => {
  for (const concepto of ["Trayecto 8 km, 16 EUR", "San José a aeropuerto", "Viaje Colombia a Panamá"]) {
    assert.equal(seleccionarContactoUber(contactos,"Uber",concepto)?.id,"u");
  }
  assert.equal(seleccionarContactoUber(contactos,"Uber Systems Spain SL.","Viaje 8km")?.id,"u");
});
test("never substitutes another country or chooses a duplicate arbitrarily", () => {
  assert.equal(seleccionarContactoUber(contactos.filter(c=>c.id!=="co"),"Uber","Bogotá"),undefined);
  assert.equal(seleccionarContactoUber([...contactos,{id:"co2",name:"Uber Colombia"}],"Uber","Bogotá"),undefined);
  assert.equal(seleccionarContactoUber(contactos.filter(c=>c.id!=="u"),"Uber","8km"),undefined);
  assert.equal(seleccionarContactoUber([...contactos,contactos[0]],"Uber","Bogotá")?.id,"co");
});
test("does not conflate Uber Eats or unrelated vendors with transport", () => {
  assert.equal(destinoProveedorUber("Uber Eats","México"),undefined);
  assert.equal(destinoProveedorUber("SuperUber","Colombia"),undefined);
  assert.equal(destinoProveedorUber("Uber Costa Rica"),"Costa Rica");
});

test("authorized Uber Eats duplicates resolve deterministically, ignoring transport", () => {
  const cs = [{id:"z",name:"Uber eats"},{id:"a",name:"UBER EATS"},{id:"0",name:"UBER COLOMBIA"}];
  assert.equal(seleccionarContactoUberEats(cs,"Uber Eats")?.id,"a");
  assert.equal(seleccionarContactoUberEats([...cs].reverse(),"UBER EATS")?.id,"a");
  assert.equal(seleccionarContactoUberEats(cs,"Uber"),undefined);
});

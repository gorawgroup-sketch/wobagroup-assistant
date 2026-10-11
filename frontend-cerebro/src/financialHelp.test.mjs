import test from 'node:test';
import assert from 'node:assert/strict';
import {financialHelp} from './modules/navegador/financialHelp.mjs';
test('ofrece Telegram para revisar estados financieros sin depender del nombre dictado',()=>{
 for(const text of ['puede revisar los estados financieros de boba','¿Puedes analizar los estados financieros de WOBA?','revisa las cuentas anuales de eWorks'])assert.equal(financialHelp(text),true);
});
test('no sustituye consultas, navegación, fallos o permisos',()=>{
 for(const text of ['abre Finanzas','muéstrame pagos pendientes','revisa los seguros','costos de hoy','no tengo permiso',null])assert.equal(financialHelp(text),false);
});

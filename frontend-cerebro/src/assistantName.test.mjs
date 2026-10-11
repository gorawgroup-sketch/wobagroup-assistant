import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeAssistantName} from './modules/navegador/assistantName.mjs';
test('corrección contextual del nombre que el dictado confundió',()=>{for(const [a,b] of [['hola Guapi','hola WOBi'],['Hola, Guapi, ¿cómo estás?','Hola, WOBi, ¿cómo estás?'],['Guapi abre seguros','WOBi abre seguros'],['cómo estás Guapi','cómo estás WOBi'],['Guapi, busca pagos','WOBi, busca pagos']])assert.equal(normalizeAssistantName(a),b);});
test('no cambia lugares, documentos, proveedores ni fragmentos de palabras',()=>{for(const a of ['busca documentos en Guapi','pagos de Guapi','Guapi es un municipio','guapísimo','abre la factura de Guapi','hola Wobi',null])assert.equal(normalizeAssistantName(a),a);});

/** Intenciones cotidianas composables; nunca identifica destinos ni ejecuta operaciones. */
export type IntencionCotidiana = "saludo" | "estado" | "ayuda" | "presentacion" | "identidad" | "gracias" | "despedida" | "aclaracion" | "animo" | "confirmacion" | "pausa";
export interface DialogoCotidiano { intenciones: IntencionCotidiana[]; repetir?: boolean }
export interface ContextoCotidiano { intencion: IntencionCotidiana; turno: number }
const normalizar = (texto: string) => texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b(?:wobi|woby|wobby|wovi|wowi|bobi|bobby|guapi)\b/g, " ").replace(/\bhol+a+\b/g, "hola").replace(/\s+/g, " ").trim();
// El residuo debe seguir siendo conversación cotidiana: «hola, abre X» y consultas concretas pasan al navegador/chat.
const RELLENO = new Set(("a al se vamos decir comprendo algo alguien alguna algunas algun algunos ante aqui ahi ahora bueno buenos buenas buen con conmigo como cual cuales cuentame de del desde dime el ella en entonces es esa ese eso esta estas estamos estoy este esto eres hay la las le les lo los mas me mi mis muy nada necesito necesitas no nos nosotros o otra otro para pero por porque pues que quiero quiere quieren quisiera si sin soy su sus te ti todo todos tu tus un una unas uno unos ustedes usted vale vez ya y favor porfa porfis claro realmente bastante poco paso empezar empezar donde todavia saber conocer " +
"saludo saludos hola holi hey ey oye ok okay bien perfecto excelente genial estupendo gracias muchas muchisimas mucho gusto igualmente encantado encantada hasta luego pronto adios chao chau vemos hablamos despedirme listo lista preparado preparada disponible presente tal va vas andas encuentras funciona funcionar llamas llamo nombre quien sabes recuerdas reconoces reconocer conoces identidad persona usuario sesion presentate presentarte presentar presentacion asistente robot humano humana haces hacer puedes podria podrias puedo puede podemos sirves sirve servir capacidades capaz opciones ofrecer ofreces pedirte preguntarte preguntas preguntar decirte hablar conversar contigo charlar conversacion explicame explicarlo explicar explicas explica entendi entiendo entender entendiendo comprendido comprendi comprender empezar empiezo comenzamos comenzar comienza comencemos ayudame ayudarme ayudas ayudes ayuda ayudar ayudarnos ayudarias apoyo apoyarme apoyar orientame orientar orientarme orientacion acompaname acompanas acompanar echa echar echas mano dar das dame darme necesitamos problema problemas resolver resuelvo resuelves encontrar buscar buscarme buscarlo trabajar trabajo repite repiteme repetir repetirme nuevo nuevamente ultimo dijiste dices decias cansado cansada estresado estresada preocupado preocupada perdido perdida confundido confundida mal regular feliz contento contenta ocupado ocupada despacio calma tranquilidad entendiste entendido acuerdo correcto exacto adelante agradezco agradecido agradecida amable amabilidad mil cuentas cuento contar cuentame escuchas oyes escuchando entiende entiendes ayudita ayuditas pequeno pequena poquito breve sencillo sencilla mejor simple hoy manana noche tardes tarde dias dia necesitas necesitas podrias pudieras podrias podria puedes poder ayuden ayude ayudan amablemente saber sabes conoce conocer recuerdas recuerde recordar entender entendemos trabajas trabaja eres ser").split(" "));

export function reconocerCotidiano(texto: string, previo?: ContextoCotidiano): DialogoCotidiano | null {
  const t = normalizar(texto);
  if (!t || t.split(" ").some(p => !RELLENO.has(p))) return null;
  if (/\b(repite|repiteme|repetir|repetirme|otra vez|de nuevo|nuevamente|que dijiste)\b/.test(t)) return previo ? { intenciones: [previo.intencion], repetir: true } : { intenciones: ["aclaracion"] };
  if (/^(?:y )?tu(?: que tal| como estas)?$/.test(t)) return previo ? { intenciones: ["estado"] } : null;
  if (/^(?:si|vale|ok|okay|claro|perfecto|genial|excelente|de acuerdo|entendido|correcto)(?: gracias)?$/.test(t)) return previo ? { intenciones: ["confirmacion"] } : null;
  const intenciones: IntencionCotidiana[] = [];
  if (/\b(no gracias|no necesito|por ahora nada|nada mas)\b/.test(t)) return { intenciones: ["pausa"] };
  if (/\b(hola|holi|buenas|buenos dias|buen dia|saludos|hey|ey)\b/.test(t)) intenciones.push("saludo");
  if (/\b(como (?:estas|andas|te encuentras|va|vas)|que tal|todo bien|estas (?:ahi|disponible|listo|lista)|me (?:escuchas|oyes|entiendes))\b/.test(t)) intenciones.push("estado");
  if (/\b(como me llamo|quien soy|mi nombre|me (?:reconoces|conoces|recuerdas)|que usuario|mi identidad|mi sesion)\b/.test(t)) intenciones.push("identidad");
  if (/\b(quien eres|que eres|como te llamas|presentate|presentarte|presentar|presentacion|eres (?:un |una )?(?:robot|humano|humana|asistente))\b/.test(t)) intenciones.push("presentacion");
  if (/\b(ayud[a-z]*|apoy[a-z]*|orient[a-z]*|acompan[a-z]*|una mano|por donde (?:empiezo|empezar|comenzar)|que (?:puedes|sabes|haces|opciones|capacidades)|puedes (?:encontrar|buscar)|podrias (?:encontrar|buscar)|como (?:funciona|funcionar|puedes)|en que|para que (?:sirves|sirve)|que puedo (?:pedirte|preguntarte|preguntar)|que me (?:ofreces|puedes))\b/.test(t)) intenciones.push("ayuda");
  if (/\b(no (?:entiendo|entendi|comprendi|comprendo)|explicame|explicar|explicarlo|mas (?:simple|sencillo|sencilla|despacio)|paso a paso)\b/.test(t)) intenciones.push("aclaracion");
  if (/\b(cansad[oa]|estresad[oa]|preocupad[oa]|perdid[oa]|confundid[oa]|estoy (?:bien|mal|regular|feliz|contento|contenta))\b/.test(t)) intenciones.push("animo");
  if (/\b(gracias|agradezco|agradecid[oa]|muy amable)\b/.test(t)) intenciones.push("gracias");
  if (/\b(adios|chao|chau|hasta (?:luego|pronto|manana)|nos vemos|hablamos luego|despedirme)\b/.test(t)) intenciones.push("despedida");
  return intenciones.length ? { intenciones } : null;
}

/** Nombre de la identidad de la sesión; jamás del texto ni del cuerpo del cliente. */
export function nombreCercano(nombre?: string): string | undefined {
  if (!nombre || nombre.length > 100 || !/^[\p{L}\p{M} .'-]+$/u.test(nombre)) return undefined;
  return nombre.trim().split(/\s+/)[0] || undefined;
}

export function responderCotidiano(d: DialogoCotidiano, nombre?: string, areas: string[] = [], previo?: ContextoCotidiano): string {
  const n = nombreCercano(nombre), vocativo = n ? ", " + n : "";
  const tiene = (i: IntencionCotidiana) => d.intenciones.includes(i);
  const partes: string[] = [];
  if (tiene("saludo")) partes.push("¡Hola" + vocativo + "! " + (previo && !d.repetir ? "Qué gusto seguir conversando contigo." : "Qué gusto saludarte."));
  if (tiene("estado")) partes.push((tiene("saludo") ? "Estoy" : "Aquí estoy" + vocativo + ",") + " listo para ayudarte. Puedes hablarme con tus propias palabras.");
  if (tiene("identidad")) partes.push(n ? "En esta sesión te tengo como " + n + ". Uso el nombre de tu sesión para acompañarte en la conversación." : "Esta sesión no me proporciona un nombre. Puedes revisarlo en tus ajustes de acceso para que pueda dirigirme a ti por tu nombre.");
  if (tiene("presentacion")) partes.push("Soy WOBi" + vocativo + ", tu asistente de WOBA, eWorks y Footprint Global. Te ayudo a encontrar información y las herramientas disponibles para tu sesión.");
  if (tiene("ayuda")) partes.push("Claro" + (tiene("saludo") ? "" : vocativo) + ", te ayudo. Cuéntame qué necesitas resolver, aunque no sepas cómo se llama el área." + (areas.length ? " En tu sesión puedes explorar " + areas.join(", ") + "." : "") + " También puedes preguntarme por los pagos, las renovaciones y la actividad de Seguros. Para una gestión que necesite procesamiento, te acompaño a continuar con WOBi en Telegram.");
  if (tiene("aclaracion")) partes.push("Vamos paso a paso" + vocativo + ". Dime qué parte te resulta confusa o qué quieres resolver y comenzamos por ahí.");
  if (tiene("animo")) partes.push("Vamos con calma" + vocativo + ". Podemos empezar por una sola cosa: cuéntame qué necesitas resolver primero.");
  if (tiene("gracias")) partes.push(("¡Con gusto" + (tiene("saludo") ? "" : vocativo) + "! " + (tiene("despedida") ? "" : "Seguimos cuando lo necesites.")).trim());
  if (tiene("despedida")) partes.push("¡Hasta luego" + vocativo + "! Aquí estaré cuando necesites ayuda.");
  if (tiene("confirmacion")) partes.push("Perfecto" + vocativo + ". " + (previo?.intencion === "ayuda" || previo?.intencion === "aclaracion" ? "Cuéntame qué necesitas consultar y vamos paso a paso." : "¿Con qué seguimos?"));
  if (tiene("pausa")) partes.push("De acuerdo" + vocativo + ". Aquí estaré cuando quieras continuar.");
  if (tiene("saludo") && d.intenciones.length === 1) partes.push("¿En qué te puedo ayudar?");
  return partes.join(" ");
}

// Crea el cobro en Mercado Pago (Checkout Pro) y guarda el pedido como "pendiente" en Supabase.
// Variables en Vercel: MP_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY

const SITIO = "https://xn--tamalesdoajuana-6qb.com";   // tamalesdoñajuana.com
const ORIGENES = [SITIO, "https://www.xn--tamalesdoajuana-6qb.com"];
const PRECIO_MEDIA = 100;        // debe coincidir con la página
const MIN_PIEZAS = 12;
const PIEZAS = { docena: 12, media: 6 };
const SABORES = {
  adobo: "Puerco en adobo",
  verde: "Pollo en salsa verde",
  mole: "Pollo en mole almendrado",
  chicharron: "Chicharrón prensado",
  frijolchorizo: "Frijoles con chorizo y queso manchego",
  frijolqueso: "Frijoles con queso manchego",
  rajas: "Rajas con queso",
};

function mananaCDMX() {
  const hoy = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
  hoy.setDate(hoy.getDate() + 1);
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
}

function codigoNuevo() {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "DJ-";
  for (let i = 0; i < 6; i++) c += letras[Math.floor(Math.random() * letras.length)];
  return c;
}

export default async function handler(req, res) {
  const origen = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ORIGENES.includes(origen) ? origen : SITIO);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });

  try {
    const p = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // --- se recalcula todo aquí; nunca se confía en los precios del navegador ---
    const paquetes = Array.isArray(p.paquetes) ? p.paquetes.slice(0, 40) : [];
    const items = [];
    const sabores = {};
    let piezas = 0;
    for (const k of paquetes) {
      const n = PIEZAS[k && k.tamano];
      if (!n) return res.status(400).json({ error: "Tamaño inválido" });
      let titulo;
      if (k.tipo === "sabor") {
        const nom = SABORES[k.sabor];
        if (!nom) return res.status(400).json({ error: "Sabor inválido" });
        sabores[nom] = (sabores[nom] || 0) + n;
        titulo = `${k.tamano === "docena" ? "Docena" : "Media docena"} de ${nom}`;
      } else if (k.tipo === "surtida") {
        let suma = 0; const partes = [];
        for (const [id, v] of Object.entries(k.pares || {})) {
          const nom = SABORES[id];
          if (!nom || !Number.isInteger(v) || v < 0) return res.status(400).json({ error: "Surtido inválido" });
          if (v) { suma += v; partes.push(`${v * 2} ${nom}`); sabores[nom] = (sabores[nom] || 0) + v * 2; }
        }
        if (suma * 2 !== n) return res.status(400).json({ error: "El surtido no está completo" });
        titulo = `${k.tamano === "docena" ? "Docena" : "Media docena"} surtida (${partes.join(", ")})`;
      } else return res.status(400).json({ error: "Paquete inválido" });
      piezas += n;
      items.push({ title: titulo.slice(0, 250), quantity: 1, unit_price: (n / 6) * PRECIO_MEDIA, currency_id: "MXN" });
    }
    if (piezas < MIN_PIEZAS) return res.status(400).json({ error: "El pedido mínimo es una docena" });
    const subtotal = items.reduce((a, i) => a + i.unit_price, 0);

    const c = p.cliente || {}, e = p.entrega || {};
    const nombre = String(c.nombre || "").trim().slice(0, 80);
    const telefono = String(c.telefono || "").replace(/\D/g, "").slice(-10);
    const correo = String(c.correo || "").trim().slice(0, 120);
    if (!nombre || telefono.length !== 10) return res.status(400).json({ error: "Faltan nombre o WhatsApp" });

    const fecha = String(e.fecha || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha < mananaCDMX()) return res.status(400).json({ error: "Fecha de entrega inválida" });
    const horario = String(e.horario || "").slice(0, 40);
    if (!horario) return res.status(400).json({ error: "Falta el horario" });

    let envio = 0, colonia = null, cp = null, direccion = null;
    if (e.tipo === "domicilio") {
      cp = String(e.cp || "");
      direccion = String(e.direccion || "").trim().slice(0, 300);
      const datos = await (await fetch(SITIO + "/envios.json")).json();
      const lugar = datos.cps && datos.cps[cp];
      const tarifa = lugar && datos.tarifas.find(([hasta]) => lugar[0] <= hasta);
      if (!tarifa) return res.status(400).json({ error: "No llegamos a ese código postal" });
      if (direccion.length < 10) return res.status(400).json({ error: "Falta la dirección" });
      envio = tarifa[1];
      colonia = lugar[1];
      if (envio > 0) items.push({ title: `Envío a domicilio (CP ${cp})`, quantity: 1, unit_price: envio, currency_id: "MXN" });
    } else if (e.tipo !== "recoger") return res.status(400).json({ error: "Tipo de entrega inválido" });

    // 1) Guardar el pedido como pendiente
    const codigo = codigoNuevo();
    const supa = {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    };
    const guardar = await fetch(`${process.env.SUPABASE_URL}/rest/v1/pedidos_tamales`, {
      method: "POST",
      headers: { ...supa, Prefer: "return=minimal" },
      body: JSON.stringify({
        codigo, nombre, telefono, correo: correo || null,
        tipo_entrega: e.tipo, cp, colonia, direccion,
        fecha_entrega: fecha, horario, notas: String(e.notas || "").slice(0, 300) || null,
        piezas, sabores, paquetes, subtotal, envio, total: subtotal + envio,
      }),
    });
    if (!guardar.ok) {
      console.error("Supabase no guardó el pedido:", await guardar.text());
      return res.status(500).json({ error: "No se pudo guardar el pedido" });
    }

    // 2) Crear el cobro en Mercado Pago
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const mp = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        items,
        payer: { name: nombre, phone: { area_code: "52", number: telefono }, ...(/^\S+@\S+\.\S+$/.test(correo) ? { email: correo } : {}) },
        external_reference: codigo,
        statement_descriptor: "DONAJUANA",
        notification_url: `https://${host}/api/mercadopago-webhook`,
        back_urls: {
          success: `${SITIO}/?pago=exito`,
          pending: `${SITIO}/?pago=pendiente`,
          failure: `${SITIO}/?pago=error`,
        },
        auto_return: "approved",
      }),
    });
    const data = await mp.json();
    if (!mp.ok || !data.init_point) {
      console.error("Mercado Pago respondió:", mp.status, JSON.stringify(data));
      return res.status(502).json({ error: "Mercado Pago no aceptó el pedido" });
    }
    return res.status(200).json({ init_point: data.init_point, codigo, total: subtotal + envio });
  } catch (err) {
    console.error("Error en checkout:", err);
    return res.status(500).json({ error: "Error inesperado" });
  }
}

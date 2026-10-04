// Mercado Pago avisa aquí cuando cambia un pago. Si quedó aprobado:
// marca el pedido como "pagado" en Supabase y te avisa por los canales que tengas configurados.
// Variables en Vercel (obligatorias): MP_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Avisos (pon las de los canales que quieras usar; los que no tengan variables se saltan):
//   Correo:    RESEND_API_KEY, AVISO_CORREO_PARA, AVISO_CORREO_DE  (ej. "Doña Juana <pedidos@boletogo.com.mx>")
//   Telegram:  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   WhatsApp:  CALLMEBOT_PHONE, CALLMEBOT_APIKEY

const pesos = n => "$" + Number(n).toLocaleString("es-MX");
const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function fechaBonita(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d, 12)).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

async function avisarCorreo(asunto, texto) {
  const key = process.env.RESEND_API_KEY, para = process.env.AVISO_CORREO_PARA;
  if (!key || !para) return;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      from: process.env.AVISO_CORREO_DE || "Doña Juana <onboarding@resend.dev>",
      to: para.split(",").map(x => x.trim()),
      subject: asunto,
      html: `<pre style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;white-space:pre-wrap">${esc(texto)}</pre>`,
    }),
  });
  if (!r.ok) console.error("Resend falló:", await r.text()); else console.log("Correo enviado");
}

async function avisarTelegram(texto) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) return;
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true }),
  });
  if (!r.ok) console.error("Telegram falló:", await r.text()); else console.log("Telegram enviado");
}

async function avisarWhatsApp(texto) {
  const phone = process.env.CALLMEBOT_PHONE, apikey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apikey) return;
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(texto)}&apikey=${encodeURIComponent(apikey)}`;
  const r = await fetch(url);
  if (!r.ok) console.error("CallMeBot falló:", r.status, await r.text()); else console.log("WhatsApp enviado");
}

export default async function handler(req, res) {
  try {
    // Checkout Pro manda "payment" y "merchant_order"; se leen las dos (igual que BoletoGO).
    const type = req.query.type || req.query.topic || (req.body && req.body.type);
    const id = req.query["data.id"] || req.query.id || (req.body && req.body.data && req.body.data.id);
    if (!id) return res.status(200).json({ received: true });

    const mpHeaders = { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` };
    let codigo = null, aprobado = false, pagoId = String(id);

    if (type === "payment") {
      const pago = await (await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`, { headers: mpHeaders })).json();
      aprobado = pago.status === "approved";
      codigo = pago.external_reference;
    } else if (type === "merchant_order") {
      const orden = await (await fetch(`https://api.mercadopago.com/merchant_orders/${encodeURIComponent(id)}`, { headers: mpHeaders })).json();
      codigo = orden.external_reference;
      const ok = Array.isArray(orden.payments) && orden.payments.find(x => x.status === "approved");
      aprobado = !!ok;
      if (ok) pagoId = String(ok.id);
    } else {
      return res.status(200).json({ received: true });
    }

    if (!aprobado || !codigo || !/^DJ-[A-Z0-9]{6}$/.test(codigo)) return res.status(200).json({ received: true });

    const supa = {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    };
    const base = `${process.env.SUPABASE_URL}/rest/v1/pedidos_tamales?codigo=eq.${encodeURIComponent(codigo)}`;

    // Marcar como pagado SOLO si seguía pendiente (así el WhatsApp no llega dos veces)
    const upd = await fetch(`${base}&estado_pago=eq.pendiente`, {
      method: "PATCH",
      headers: { ...supa, Prefer: "return=representation" },
      body: JSON.stringify({ estado_pago: "pagado", mp_payment_id: pagoId, pagado_en: new Date().toISOString() }),
    });
    const filas = await upd.json();
    if (!Array.isArray(filas) || !filas.length) return res.status(200).json({ received: true }); // ya estaba pagado o no existe
    const p = filas[0];

    const lineas = Object.entries(p.sabores).map(([s, n]) => `• ${n} ${s}`).join("\n");
    const entrega = p.tipo_entrega === "domicilio"
      ? `🛵 A domicilio\n${p.direccion}\nCP ${p.cp}${p.colonia ? " · " + p.colonia : ""}`
      : "🏠 Pasa a recoger a Tula 61";
    const texto =
`🫔 NUEVO PEDIDO PAGADO ${p.codigo}

📅 ${fechaBonita(p.fecha_entrega)}, ${p.horario}
${entrega}

${p.piezas} piezas:
${lineas}

Tamales ${pesos(p.subtotal)}${p.envio ? ` + envío ${pesos(p.envio)}` : ""} = ${pesos(p.total)}

👤 ${p.nombre}
📱 wa.me/52${p.telefono}${p.notas ? `\n📝 ${p.notas}` : ""}`;

    const asunto = `Nuevo pedido ${p.codigo}: ${p.piezas} tamales para ${fechaBonita(p.fecha_entrega)}`;
    await Promise.allSettled([avisarCorreo(asunto, texto), avisarTelegram(texto), avisarWhatsApp(texto)]);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Error en webhook:", err);
    return res.status(200).json({ received: true });
  }
}

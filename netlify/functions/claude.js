// Proxy a la API de Anthropic. La clave vive solo en la variable de entorno ANTHROPIC_API_KEY.
export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ error: { message: "Falta ANTHROPIC_API_KEY en Netlify." } }, { status: 500 });
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: { message: "JSON inválido" } }, { status: 400 }); }
  // Solo se reenvían los campos necesarios y se limita el tamaño de salida.
  const payload = {
    model: process.env.CLAUDE_MODEL || body.model,
    max_tokens: Math.min(Number(body.max_tokens) || 1024, 4096),
    system: body.system,
    messages: body.messages
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(payload)
  });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
};
export const config = { path: "/.netlify/functions/claude" };

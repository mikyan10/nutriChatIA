import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Send, MessageCircle, LayoutGrid, History as HistoryIcon, Settings as SettingsIcon,
  Check, X, Trash2, Plus, Flame, Star, ChefHat, Scale, Sun, Moon, ChevronRight, ChevronLeft,
  Loader2, Sparkles, Camera, AlertCircle, Download, Upload, Database, AlertTriangle
} from "lucide-react";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, BarChart, Bar, CartesianGrid } from "recharts";

/* ============================================================
   NutriChat AI — prototipo funcional
   ------------------------------------------------------------
   Esta es una implementación real y usable del producto definido
   en el documento técnico, adaptada a lo que este entorno puede
   ejecutar: una sola app cliente (sin backend NestJS, sin Postgres,
   sin despliegue nativo iOS/Android). Aun así:

   - El registro conversacional (texto y voz) es 100% funcional.
   - La interpretación de lenguaje natural la hace Claude de verdad
     (misma API que usaría el "Servicio de NLU Nutricional").
   - Como aquí no hay credenciales de FatSecret, los valores
     nutricionales los estima Claude con criterio de tabla de
     composición española/europea (misma forma que food_cache:
     valores por 100 g), dejando el punto de integración aislado
     en resolveFoodsWithAI() para sustituirlo por FatSecret real.
   - Los datos persisten entre sesiones vía window.storage
     (equivalente local a la base de datos de usuario).
   ============================================================ */

// ---------- Diseño: tokens ----------
const palette = {
  light: {
    bg: "#FAFAF7", surface: "#FFFFFF", surfaceSoft: "#F1F0EA", border: "#E7E5DE",
    text: "#1B1B18", textDim: "#6B6A63", accent: "#2E5339",
    kcal: "#1B1B18", protein: "#3E7C5A", fat: "#C98A2C", carbs: "#3B6EA5",
    danger: "#B4463C", bubbleUser: "#1B1B18", bubbleUserText: "#FAFAF7",
    bubbleAI: "#F1F0EA", bubbleAIText: "#1B1B18",
    accentTint: "#EAEFE9", accentTintText: "#3E5A45"
  },
  dark: {
    bg: "#111110", surface: "#1A1A18", surfaceSoft: "#232320", border: "#333330",
    text: "#F2F1EA", textDim: "#96958C", accent: "#7FBF97",
    kcal: "#F2F1EA", protein: "#7FBF97", fat: "#E3AE5C", carbs: "#7FA8D9",
    danger: "#E08277", bubbleUser: "#F2F1EA", bubbleUserText: "#111110",
    bubbleAI: "#232320", bubbleAIText: "#F2F1EA",
    accentTint: "#16231C", accentTintText: "#9FCDAE"
  }
};

const MACRO_LABELS = { protein: "Proteína", fat: "Grasas", carbs: "Hidratos" };

// ---------- Utilidades ----------
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const pad = (n) => String(n).padStart(2, "0");
const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => toDateStr(new Date());

// Intenta resolver la fecha que devolvió la IA con la máxima tolerancia posible antes
// de rendirse y usar hoy por defecto. Devuelve también si tuvo que recurrir al valor
// por defecto, para poder avisar al usuario en vez de fallar en silencio.
function resolveMealDate(rawDateStr) {
  if (!rawDateStr) return { date: todayStr(), dateWasFallback: false };
  const isoMatch = rawDateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return { date: `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`, dateWasFallback: false };
  const dmyMatch = rawDateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyMatch) return { date: `${dmyMatch[3]}-${pad(dmyMatch[2])}-${pad(dmyMatch[1])}`, dateWasFallback: false };
  const parsed = new Date(rawDateStr);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 2000) return { date: toDateStr(parsed), dateWasFallback: false };
  return { date: todayStr(), dateWasFallback: true };
}
const humanDate = (dateStr) => {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
};
// Semana personalizada: jueves (día 1) a miércoles (día 7), en vez de la semana ISO
// (lunes-domingo). Afecta a todos los cálculos semanales de la app: banco calórico,
// vista "Semana" del historial e informe semanal.
function startOfCustomWeek(date) {
  const d = new Date(date);
  const idx = (d.getDay() + 3) % 7; // jueves=0 ... miércoles=6
  d.setDate(d.getDate() - idx);
  d.setHours(0, 0, 0, 0);
  return d;
}
function weekDates(date) {
  const start = startOfCustomWeek(date);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return toDateStr(d);
  });
}
function round1(n) { return Math.round(n * 10) / 10; }
function normalizePhrase(text) { return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,!?¡¿]/g, ""); }
// Para comparar coincidencias de autocompletado ignorando tildes ("pla" debe encontrar
// "Plátano", "cafe" debe encontrar "café"). No se usa para las claves de hábitos
// (normalizePhrase), solo para la búsqueda de sugerencias.
function searchKey(text) { return normalizePhrase(text).normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }

// ---------- Storage ----------
async function loadJSON(key, fallback) {
  try {
    const res = await window.storage.get(key, false);
    if (!res) return fallback;
    return JSON.parse(res.value);
  } catch (e) { return fallback; }
}
async function saveJSON(key, value) {
  try { await window.storage.set(key, JSON.stringify(value), false); }
  catch (e) { console.error("storage error", e); }
}
// Igual que saveJSON pero SIN atrapar el error — para operaciones críticas como la
// importación, donde un fallo de escritura silencioso dejaría a la app pensando que
// todo se importó bien cuando en realidad no se guardó nada.
async function saveJSONStrict(key, value) {
  const result = await window.storage.set(key, JSON.stringify(value), false);
  if (!result) throw new Error(`No se pudo guardar "${key}" (el almacenamiento no confirmó la escritura).`);
  return result;
}

// ---------- Cálculo de totales de una comida ----------
function computeItemAbs(item) {
  const f = item.quantity_g / 100;
  return {
    kcal: round1(item.kcal_per_100g * f),
    protein: round1(item.protein_per_100g * f),
    fat: round1(item.fat_per_100g * f),
    carbs: round1(item.carbs_per_100g * f)
  };
}
function computeMealTotals(items) {
  return items.reduce((acc, it) => {
    const a = computeItemAbs(it);
    acc.kcal += a.kcal; acc.protein += a.protein; acc.fat += a.fat; acc.carbs += a.carbs;
    return acc;
  }, { kcal: 0, protein: 0, fat: 0, carbs: 0 });
}
// Si el usuario no ha fijado un objetivo de macro manual, lo derivamos de su objetivo de
// kcal real (reparto estándar 30% proteína / 30% grasa / 40% hidratos) en vez de usar
// un número fijo desconectado de lo que el usuario configuró.
function effectiveMacroGoals(goals) {
  return {
    protein: goals.protein || round1((goals.kcal * 0.30) / 4),
    fat: goals.fat || round1((goals.kcal * 0.30) / 9),
    carbs: goals.carbs || round1((goals.kcal * 0.40) / 4)
  };
}

// Reescala los macros (manteniendo su proporción calórica) para que sumen exactamente las kcal indicadas.
function macroKcal(g) {
  return (Number(g.protein) || 0) * 4 + (Number(g.carbs) || 0) * 4 + (Number(g.fat) || 0) * 9;
}
function rebalanceMacros(g) {
  const kcal = Number(g.kcal) || 0;
  if (kcal <= 0) return g;
  let p = Number(g.protein) || 0, c = Number(g.carbs) || 0, f = Number(g.fat) || 0;
  if (!(p > 0 && c > 0 && f > 0)) { p = (kcal * 0.30) / 4; f = (kcal * 0.30) / 9; c = (kcal * 0.40) / 4; }
  const k = kcal / (p * 4 + c * 4 + f * 9);
  const protein = Math.round(p * k), fat = Math.round(f * k);
  // los hidratos absorben el redondeo para que el total cuadre
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  return { ...g, protein, fat, carbs };
}

// Reduce la foto en el propio móvil (lado largo 1280 px, JPEG) para que quepa en la función de Netlify.
function resizeImageToBase64(file, maxSide = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        URL.revokeObjectURL(url);
        resolve({ data: dataUrl.split(",")[1], mediaType: "image/jpeg", preview: dataUrl });
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la imagen (formato no compatible).")); };
    img.src = url;
  });
}

const PHOTO_RULES = `

MODO FOTO: el usuario adjunta una foto de su plato. Reglas adicionales:
- Usa intent=log_meal y describe cada alimento visible como un item, con estimated=true.
- Estima los gramos comparando con referencias visibles (tamaño del plato, cubiertos, envases, manos). Prefiere raciones realistas y no infles las cantidades.
- Incluye los ingredientes que casi seguro están aunque no se vean (aceite de cocinar en frituras o salteados, salsas evidentes) como items aparte con cantidad prudente.
- Si el usuario añade texto con cantidades o ingredientes, ese texto manda sobre lo que estimes de la imagen.
- Si la foto no muestra comida, usa intent=unclear y explícalo en "clarification".
- La fecha es hoy salvo que el texto indique otra.`;

// ---------- Llamada a Claude (NLU nutricional) ----------
function extractJSON(rawText) {
  if (!rawText) return null;
  let cleaned = rawText.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  const jsonStr = cleaned.slice(start, end + 1);
  try { return JSON.parse(jsonStr); } catch (e) { return null; }
}

function normalizeInterpretation(parsed) {
  const out = { ...parsed };
  if (!out.meal_date && out.date) out.meal_date = out.date;
  if (out.intent === "edit_meal" && out.meal_number_ref === undefined && out.meal_number !== undefined) {
    out.meal_number_ref = out.meal_number;
  }
  if (!Array.isArray(out.items)) out.items = out.items ? [out.items] : [];
  out.items = out.items.map(sanitizeFoodItem);
  if (Array.isArray(out.edits)) {
    out.edits = out.edits.map((e) => (e.new_item ? { ...e, new_item: sanitizeFoodItem(e.new_item) } : e));
  }
  return out;
}

// Los campos numéricos que devuelve la IA pueden venir como texto, ausentes o con
// nombres ligeramente distintos si el modelo no respeta el formato exacto. Los
// normalizamos siempre a número (0 si no es interpretable) para que nunca se cuele
// un NaN o un string en los totales mostrados en el dashboard.
function toNum(v, fallback = 0) {
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function sanitizeFoodItem(it) {
  if (!it || typeof it !== "object") return { name: "Alimento", quantity_g: 0, estimated: true, kcal_per_100g: 0, protein_per_100g: 0, fat_per_100g: 0, carbs_per_100g: 0, unit_label: "" };
  return {
    name: it.name || "Alimento",
    quantity_g: toNum(it.quantity_g ?? it.grams ?? it.amount_g, 0),
    estimated: !!it.estimated,
    kcal_per_100g: toNum(it.kcal_per_100g ?? it.calories_per_100g ?? it.kcal, 0),
    protein_per_100g: toNum(it.protein_per_100g ?? it.protein_g_per_100g, 0),
    fat_per_100g: toNum(it.fat_per_100g ?? it.fat_g_per_100g, 0),
    carbs_per_100g: toNum(it.carbs_per_100g ?? it.carbohydrates_per_100g, 0),
    unit_label: typeof it.unit_label === "string" ? it.unit_label : ""
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Llama a la API con reintento automático. Un 200 con cuerpo vacío, un JSON corrupto
// a mitad, o un error 5xx suelen ser fallos transitorios de red/proxy, no errores
// deterministas — reintentar resuelve la mayoría sin que el usuario tenga que volver
// a escribir el mensaje. Los errores 4xx (petición inválida, límite, etc.) no se
// reintentan porque no van a cambiar de resultado.
async function fetchClaudeWithRetry(body, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch("/.netlify/functions/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        lastError = new Error(`La API devolvió una respuesta no válida (estado ${res.status}): ${rawText ? rawText.slice(0, 200) : "(respuesta vacía)"}`);
        if (attempt < maxAttempts) { await sleep(500 * attempt); continue; }
        throw lastError;
      }
      if (!res.ok) {
        const detail = data?.error?.message || JSON.stringify(data).slice(0, 200);
        lastError = new Error(`La API respondió ${res.status}: ${detail}`);
        if (res.status >= 500 && attempt < maxAttempts) { await sleep(500 * attempt); continue; }
        throw lastError;
      }
      return data;
    } catch (e) {
      lastError = e;
      if (attempt >= maxAttempts) throw lastError;
    }
  }
  throw lastError;
}

async function callClaudeInterpreter(userText, context, image) {
  const jsonShape = `{
  "intent": "log_meal" | "edit_meal" | "apply_favorite" | "save_favorite" | "weight_log" | "query" | "unclear",
  "meal_date": "YYYY-MM-DD",
  "meal_number": number opcional (solo log_meal, si el usuario indica el número explícitamente),
  "meal_number_ref": number opcional (solo edit_meal; -1 si no se especifica),
  "items": [ { "name": string, "quantity_g": number, "unit_label": string opcional (ej. "1 plátano", "1 yogur", "150 ml"), "estimated": boolean, "kcal_per_100g": number, "protein_per_100g": number, "fat_per_100g": number, "carbs_per_100g": number } ],
  "edits": [ { "op": "remove_item" | "replace_item" | "add_item", "item_name_match": string, "new_item": {mismos campos que un item} } ],
  "favorite_name": string opcional,
  "weight_kg": number opcional,
  "query_type": "kcal_consumed" | "kcal_remaining" | "protein_consumed" | "fat_consumed" | "carbs_consumed" | "meals_list" | "weekly_margin" | "dinner_suggestion" | "other",
  "query_date_or_range": "YYYY-MM-DD" opcional,
  "clarification": string opcional
}`;

  const system = `Eres el motor de interpretación de NutriChat AI, un asistente nutricional conversacional en español (España).

Tu ÚNICA salida debe ser un objeto JSON plano con exactamente esta forma (omite los campos que no apliquen a la intención detectada, no inventes campos nuevos):
${jsonShape}

Reglas MUY IMPORTANTES de formato:
- No escribas nada antes ni después del JSON.
- No uses bloques de código markdown (nada de \`\`\`).
- No des explicaciones. Solo el objeto JSON, empezando por "{" y terminando por "}".

Contexto actual:
- Fecha de hoy: ${context.today} (${context.todayWeekday})
- Tabla de referencia de los últimos 10 días exactos (úsala SIEMPRE que el usuario mencione un día de la semana, "ayer", una fecha relativa, o un número de día del mes, en vez de calcular tú la fecha — busca aquí el día de la semana o número que coincida): ${JSON.stringify(context.last10Days)}
- Última comida registrada hoy: número ${context.lastMealNumberToday ?? "ninguna"}
- Comidas ya registradas hoy (para localizar referencias de edición): ${JSON.stringify(context.todayMealsBrief)}
- Comidas favoritas guardadas: ${context.favoriteNames.join(", ") || "ninguna"}
- Última comida creada en esta conversación (para 'guárdala como favorita'): ${context.lastCreatedMealBrief || "ninguna"}

Reglas de fecha MUY IMPORTANTES:
- "meal_date" SIEMPRE debe ser exactamente uno de los valores "date" que aparecen en la tabla de referencia de los últimos 10 días (formato YYYY-MM-DD), o ${context.today} por defecto si el usuario no menciona ninguna fecha. Nunca calcules la fecha mentalmente ni inventes un formato distinto: busca en la tabla el día de la semana o el número de día que mencione el usuario y copia literalmente su campo "date".
- Ejemplo: si el usuario dice "lunes 3 Comida 1: ...", busca en la tabla la entrada cuyo "weekday" sea "lunes" (o cuyo "date" termine en "-03"), y usa ese "date" exacto como meal_date.
- Si el día que menciona el usuario no aparece en la tabla (han pasado más de 10 días), usa el formato YYYY-MM-DD igualmente, calculándolo con el máximo cuidado a partir de ${context.today}.

Reglas de interpretación:
1. Si el usuario describe una comida ("he comido...", "he desayunado...", "añade...") usa intent=log_meal y rellena "items" con cada alimento.
1bis. Esto incluye cuando el usuario indica explícitamente el número de comida al registrarla, por ejemplo "Comida 1 pan blanco 50g" o "Comida 2 del día 3 de agosto: 100 gramos de pollo, 50 gramos de arroz": sigue siendo intent=log_meal (no edit_meal), y debes rellenar además "meal_number" con ese número indicado. Esto aplica siempre que el usuario esté aportando alimentos nuevos, aunque mencione un número de comida.
2. Si no se especifica cantidad, infiere una ración estándar ampliamente aceptada (p.ej. macarrones cocidos 250 g, pechuga de pollo 150-200 g, una tostada de pan ~30 g, una pieza de fruta 120-180 g) y marca estimated=true en ese ítem. Si el usuario sí da la cantidad exacta, estimated=false.
2bis. El usuario puede indicar la cantidad como una RACIÓN o UNIDAD en vez de en gramos ("1 plátano", "un yogur", "una mousse", "2 huevos", "una manzana"). En ese caso, convierte esa unidad a su equivalente en gramos usando pesos estándar de una pieza/ración individual típica, y rellena "unit_label" con el texto que usó el usuario para esa unidad (p.ej. "1 plátano", "1 yogur"), dejando "quantity_g" como el peso real en gramos usado para el cálculo. Marca estimated=true salvo que el usuario también diera el peso exacto en gramos. Pesos de referencia orientativos (ajusta según el alimento concreto mencionado): plátano ~120 g, manzana ~150 g, naranja ~150 g, huevo mediano ~55 g, yogur natural individual ~125 g, mousse de chocolate individual ~60 g, rebanada de pan de molde ~25-30 g, loncha de queso o jamón ~15-20 g, vaso de leche o bebida vegetal ~200-250 ml. Si el usuario ya indica el peso en gramos o ml explícitamente, usa ese valor exacto y no rellenes unit_label (o dejarlo vacío).
3. Usa valores nutricionales por 100 g realistas y consistentes con una tabla de composición de alimentos española/europea (equivalente a FatSecret España).
4. Usa intent=edit_meal ÚNICAMENTE cuando el usuario claramente corrige, sustituye o elimina algo de una comida que YA fue registrada antes en la conversación o en el histórico ("cambia el pollo por pavo", "elimina las patatas", "corrige la comida 3", "en la comida 1 quita..."). Indica meal_number_ref (o -1 si no lo especifica) y rellena "edits". No uses edit_meal solo porque el mensaje mencione un número de comida: si el usuario está aportando alimentos nuevos (aunque diga "Comida 1 ..."), es log_meal, no edit_meal.
5. Si el usuario pide cargar una comida guardada por nombre (coincide con una de las favoritas), usa intent=apply_favorite y favorite_name.
6. Si el usuario pide guardar la última comida como favorita ("guarda esto como desayuno habitual"), usa intent=save_favorite y favorite_name.
7. Si el usuario indica su peso ("hoy peso 78,4", "peso: 78.4 kg"), usa intent=weight_log y weight_kg.
8. Si el usuario pregunta por su progreso ("¿cuánta proteína llevo?", "¿cuántas calorías me quedan?", "enséñame las comidas del martes", "¿qué puedo cenar?"), usa intent=query con query_type y query_date_or_range si aplica. Los números reales los calculará la app, tú solo clasificas la pregunta.
9. Si el mensaje es ambiguo o no tiene relación con nutrición/peso, usa intent=unclear y una pregunta breve en "clarification".
Fecha por defecto si no se indica ninguna: ${context.today}.${image ? PHOTO_RULES : ""}`;

  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: image ? 1500 : 1000,
    system,
    messages: [{
      role: "user",
      content: image
        ? [
            { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
            { type: "text", text: userText || "Esta es la foto de mi plato. Estima los alimentos y las cantidades." }
          ]
        : userText
    }]
  };

  const data = await fetchClaudeWithRetry(body);
  const toolUse = (data.content || []).find((b) => b.type === "tool_use");
  if (toolUse) return normalizeInterpretation(toolUse.input);

  const textBlock = (data.content || []).find((b) => b.type === "text");
  const parsed = textBlock ? extractJSON(textBlock.text) : null;
  if (parsed) return normalizeInterpretation(parsed);

  throw new Error(textBlock ? `No se pudo extraer JSON de la respuesta: "${textBlock.text.slice(0, 150)}"` : "La IA no devolvió ningún contenido interpretable.");
}

async function callClaudeText(prompt) {
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: "Eres el redactor de valoraciones de NutriChat AI. Recibes datos numéricos ya calculados (nunca los inventas ni los recalculas) y escribes una valoración breve, concreta y en español de España, en 2-4 frases o viñetas cortas. Tono cercano, sin emojis excesivos, sin sonar clínico ni alarmista.",
    messages: [{ role: "user", content: prompt }]
  };
  const data = await fetchClaudeWithRetry(body);
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock || !textBlock.text) throw new Error("La IA no devolvió ningún texto.");
  return textBlock.text;
}

// ---------- Notificaciones inteligentes (banner contextual) ----------
function useNotificationBanner(colors, goals, meals) {
  const [banner, setBanner] = useState(null);
  const [dismissedKey, setDismissedKey] = useState(null);
  useEffect(() => {
    (async () => {
      const now = new Date();
      const hour = now.getHours();
      const today = todayStr();
      const list = meals[today] || [];
      const totalKcal = list.reduce((s, m) => s + computeMealTotals(m.items).kcal, 0);
      const shown = await loadJSON(`notif-shown-${today}`, []);
      let type = null, text = null;
      if (list.length === 0 && hour >= 11 && hour < 22) { type = "no_meals"; text = "Aún no has registrado ninguna comida hoy."; }
      else if (hour >= 15 && hour < 18 && totalKcal < goals.kcal * 0.35) { type = "low_intake"; text = `Solo llevas ${round1(totalKcal)} kcal hoy.`; }
      else if (hour >= 19 && hour < 21) {
        const remaining = goals.kcal - totalKcal;
        if (remaining > 100) { type = "dinner_margin"; text = `Te quedan aproximadamente ${round1(remaining)} kcal para la cena.`; }
      }
      if (type && !shown.includes(type)) {
        setBanner({ type, text });
      } else {
        setBanner(null);
      }
    })();
  }, [meals, goals]);

  const dismiss = useCallback(async () => {
    if (!banner) return;
    const today = todayStr();
    const shown = await loadJSON(`notif-shown-${today}`, []);
    await saveJSON(`notif-shown-${today}`, [...shown, banner.type]);
    setBanner(null);
  }, [banner]);

  return { banner, dismiss };
}

// ---------- Componentes visuales base ----------
function Ring({ value, max, size = 168, stroke = 14, color, trackColor, label, sub }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke={trackColor} strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none"
          strokeDasharray={c} strokeDashoffset={c - c * pct} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(.4,0,.2,1)" }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontSize: 30, fontWeight: 600, lineHeight: 1 }}>{Math.round(value)}</div>
        <div style={{ fontSize: 12, opacity: 0.55, marginTop: 4 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, opacity: 0.45 }}>{sub}</div>}
      </div>
    </div>
  );
}

function MacroBar({ label, value, max, color, colors }) {
  const pct = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1.5" style={{ fontSize: 12.5 }}>
        <span className="flex items-center gap-2" style={{ color: colors.textDim }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
          {label}
        </span>
        <span style={{ fontWeight: 600, color: colors.text }}>{round1(value)} / {max} g</span>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: colors.surfaceSoft, overflow: "hidden" }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: color, borderRadius: 999, transition: "width 0.5s ease" }} />
      </div>
    </div>
  );
}

function Card({ children, colors, style }) {
  return (
    <div style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 20, padding: 16, ...style }}>
      {children}
    </div>
  );
}

// ---------- Tarjeta de comida interpretada (dentro del chat) ----------
function MealCard({ meal, colors, onConfirm, onDiscard, onChangeQty, onRemoveItem, pending }) {
  const totals = computeMealTotals(meal.items);
  return (
    <Card colors={colors} style={{ maxWidth: 340 }}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>
            {meal.editing ? `Editando comida ${meal.mealNumber}` : `Comida ${meal.mealNumber}`} · {humanDate(meal.date).split(",")[0]}
          </div>
          {meal.habitBased && (
            <span style={{ marginTop: 4, display: "inline-block", fontSize: 9.5, fontWeight: 600, color: colors.accent, background: `${colors.accent}1A`, padding: "2px 6px", borderRadius: 8 }}>
              HÁBITO APRENDIDO
            </span>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0, lineHeight: 1 }}>
          <span style={{ fontSize: 19, fontWeight: 600, color: colors.text }}>{round1(totals.kcal)}</span>
          <span style={{ fontSize: 11, color: colors.textDim }}> kcal</span>
        </div>
      </div>
      {meal.items.map((it, i) => {
        const a = computeItemAbs(it);
        return (
          <div key={i} className="flex items-center justify-between" style={{ padding: "7px 0", borderTop: i === 0 ? "none" : `1px solid ${colors.border}` }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5 }}>
                {it.name}{" "}
                {it.estimated && <span style={{ fontSize: 10, background: colors.surfaceSoft, color: colors.textDim, padding: "1px 6px", borderRadius: 8 }}>estimado</span>}
              </div>
              <div style={{ fontSize: 11, color: colors.textDim }}>{it.unit_label ? `${it.unit_label} (${it.quantity_g}g)` : `${it.quantity_g}g`}</div>
              {pending && <div style={{ fontSize: 11.5, color: colors.textDim }}>{a.kcal} kcal · P {a.protein}g · G {a.fat}g · H {a.carbs}g</div>}
            </div>
            {pending ? (
              <div className="flex items-center gap-1">
                <input
                  type="number" value={it.quantity_g}
                  onChange={(e) => onChangeQty(i, Number(e.target.value))}
                  style={{ width: 52, fontSize: 12, padding: "3px 4px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bg, color: colors.text }}
                />
                <span style={{ fontSize: 11, color: colors.textDim }}>g</span>
                <button onClick={() => onRemoveItem(i)} style={{ color: colors.danger, padding: 4 }}><Trash2 size={13} /></button>
              </div>
            ) : (
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: colors.text }}>{a.kcal} kcal</div>
                <div style={{ fontSize: 10.5, color: colors.textDim }}>P{a.protein} G{a.fat} H{a.carbs}</div>
              </div>
            )}
          </div>
        );
      })}
      <div className="flex justify-between items-center mt-2 pt-2" style={{ borderTop: `1px solid ${colors.border}`, fontSize: 11.5, color: colors.textDim }}>
        <span>P {round1(totals.protein)}g · G {round1(totals.fat)}g · H {round1(totals.carbs)}g</span>
      </div>
      {pending && (
        <div className="flex gap-2 mt-3">
          <button onClick={onConfirm} className="flex items-center justify-center gap-1"
            style={{ flex: 1, background: colors.accent, color: colors.bg === "#111110" ? "#111110" : "#FFF", padding: "8px 0", borderRadius: 12, fontSize: 13, fontWeight: 600 }}>
            <Check size={15} /> Confirmar
          </button>
          <button onClick={onDiscard} className="flex items-center justify-center gap-1"
            style={{ flex: 1, background: colors.surfaceSoft, color: colors.text, padding: "8px 0", borderRadius: 12, fontSize: 13, fontWeight: 600 }}>
            <X size={15} /> Descartar
          </button>
        </div>
      )}
    </Card>
  );
}

// ================= PANTALLA: CHAT =================
function ChatScreen({ colors, goals, favorites, setFavorites, habits, setHabits, meals, setMealsForDate, chatMessages, setChatMessages, initialInput, foodIndex }) {
  const [input, setInput] = useState(initialInput || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [lastCreatedMeal, setLastCreatedMeal] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [photoLoading, setPhotoLoading] = useState(false);
  const fileRef = useRef(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const { banner, dismiss: dismissBanner } = useNotificationBanner(colors, goals, meals);

  // Sugerencias de autocompletado: mientras se escribe, mira el último alimento
  // (tras la última coma) y busca coincidencias en lo ya registrado antes, para
  // sugerir el nombre exacto y la cantidad habitual sin tener que recordarla.
  const suggestions = useMemo(() => {
    const parts = input.split(",");
    const fragment = searchKey(parts[parts.length - 1] || "");
    if (fragment.length < 2 || !foodIndex || !foodIndex.length) return [];
    const matches = foodIndex.filter((f) => searchKey(f.name).includes(fragment));
    matches.sort((a, b) => {
      const aStarts = searchKey(a.name).startsWith(fragment) ? 0 : 1;
      const bStarts = searchKey(b.name).startsWith(fragment) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return b.count - a.count;
    });
    return matches.slice(0, 5);
  }, [input, foodIndex]);

  function applySuggestion(s) {
    const parts = input.split(",");
    const insertText = s.unit_label || `${s.name} ${s.quantity_g}g`;
    parts[parts.length - 1] = parts.length > 1 ? ` ${insertText}` : insertText;
    setInput(parts.join(",") + ", ");
    inputRef.current?.focus();
  }

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [chatMessages]);

  const pushMsg = (msg) => setChatMessages((prev) => [...prev, { id: uid(), ...msg }]);

  function nextMealNumber(date) {
    const list = meals[date] || [];
    return list.length ? Math.max(...list.map((m) => m.mealNumber)) + 1 : 1;
  }

  async function onPhotoPicked(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setPhotoLoading(true);
    setError(null);
    try { setPhoto(await resizeImageToBase64(file)); }
    catch (err) { setError(err?.message || "No se pudo preparar la foto."); }
    finally { setPhotoLoading(false); }
  }

  async function handleSend(text) {
    const trimmed = text.trim();
    const sentPhoto = photo;
    if ((!trimmed && !sentPhoto) || busy || photoLoading) return;
    setInput("");
    setError(null);
    pushMsg({ role: "user", text: sentPhoto ? (trimmed ? `Foto del plato: ${trimmed}` : "Foto del plato") : trimmed });
    setBusy(true);
    try {
      const today = todayStr();
      const todayList = meals[today] || [];
      const last10Days = Array.from({ length: 10 }, (_, i) => {
        const d = new Date(); d.setDate(d.getDate() - i);
        return { date: toDateStr(d), weekday: d.toLocaleDateString("es-ES", { weekday: "long" }) };
      });
      const context = {
        today,
        todayWeekday: new Date().toLocaleDateString("es-ES", { weekday: "long" }),
        last10Days,
        lastMealNumberToday: todayList.length ? Math.max(...todayList.map((m) => m.mealNumber)) : null,
        todayMealsBrief: todayList.map((m) => ({ mealNumber: m.mealNumber, items: m.items.map((it) => it.name) })),
        favoriteNames: favorites.map((f) => f.name),
        lastCreatedMealBrief: lastCreatedMeal ? lastCreatedMeal.items.map((it) => it.name).join(", ") : null
      };
      const normalized = normalizePhrase(trimmed);
      const habit = habits[normalized];
      if (!sentPhoto && habit && habit.occurrences >= 3) {
        const meal = {
          id: uid(), mealNumber: nextMealNumber(today), date: today, source: "habit",
          rawInput: trimmed, items: habit.items.map((it) => ({ id: uid(), ...it })), createdAt: new Date().toISOString(), habitBased: true
        };
        pushMsg({ role: "assistant", pendingMeal: meal, habitBased: true });
        setBusy(false);
        return;
      }
      const result = await callClaudeInterpreter(trimmed, context, sentPhoto);
      await handleResult(result, trimmed || "Foto del plato");
      if (sentPhoto) setPhoto(null);
    } catch (e) {
      console.error(e);
      const detail = e?.message || "error desconocido";
      pushMsg({ role: "assistant", text: `No he podido procesar eso tras varios intentos. Detalle técnico: ${detail}`, retryText: sentPhoto ? undefined : trimmed });
      if (sentPhoto) setInput(trimmed);
    } finally {
      setBusy(false);
    }
  }

  async function handleResult(result, rawText) {
    const { date, dateWasFallback } = resolveMealDate(result.meal_date);

    if (result.intent === "log_meal") {
      const items = (result.items || []).map((it) => ({ id: uid(), ...it }));
      if (!items.length) { pushMsg({ role: "assistant", text: "No he identificado ningún alimento en ese mensaje." }); return; }
      if (dateWasFallback && result.meal_date) {
        pushMsg({ role: "assistant", text: `No he podido interpretar la fecha "${result.meal_date}" con seguridad, así que voy a registrarlo en el día de hoy (${humanDate(todayStr())}). Si querías otro día, dime la fecha en formato "día/mes" o "3 de agosto".` });
      }
      const existingList = meals[date] || [];
      const explicitNumber = result.meal_number && result.meal_number > 0 ? result.meal_number : null;
      const existingMeal = explicitNumber ? existingList.find((m) => m.mealNumber === explicitNumber) : null;
      if (existingMeal) {
        // Ya existe esa "Comida N": se añaden los alimentos a la misma en vez de duplicarla.
        const merged = { ...existingMeal, items: [...existingMeal.items, ...items], editing: true };
        pushMsg({ role: "assistant", pendingMeal: merged, isEdit: true });
        return;
      }
      const meal = {
        id: uid(), mealNumber: explicitNumber || nextMealNumber(date), date, source: "text",
        rawInput: rawText, items, createdAt: new Date().toISOString()
      };
      pushMsg({ role: "assistant", pendingMeal: meal });
      return;
    }

    if (result.intent === "edit_meal") {
      const list = meals[date] || [];
      if (!list.length) { pushMsg({ role: "assistant", text: `No encuentro comidas registradas el ${humanDate(date)}. (Diagnóstico: la IA interpretó tu mensaje como una corrección de una comida existente — intent=edit_meal — en vez de como una comida nueva. Si tu mensaje describía alimentos nuevos, dímelo para seguir ajustando el prompt.)` }); return; }
      const targetNumber = result.meal_number_ref && result.meal_number_ref > 0 ? result.meal_number_ref : Math.max(...list.map((m) => m.mealNumber));
      const target = list.find((m) => m.mealNumber === targetNumber);
      if (!target) { pushMsg({ role: "assistant", text: `No encuentro la comida ${targetNumber} el ${humanDate(date)}.` }); return; }
      let newItems = [...target.items];
      for (const edit of result.edits || []) {
        if (edit.op === "remove_item") {
          newItems = newItems.filter((it) => !it.name.toLowerCase().includes((edit.item_name_match || "").toLowerCase()));
        } else if (edit.op === "replace_item") {
          newItems = newItems.filter((it) => !it.name.toLowerCase().includes((edit.item_name_match || "").toLowerCase()));
          if (edit.new_item) newItems.push({ id: uid(), ...edit.new_item });
        } else if (edit.op === "add_item" && edit.new_item) {
          newItems.push({ id: uid(), ...edit.new_item });
        }
      }
      const editedMeal = { ...target, items: newItems, editing: true };
      pushMsg({ role: "assistant", pendingMeal: editedMeal, isEdit: true });
      return;
    }

    if (result.intent === "apply_favorite") {
      const fav = favorites.find((f) => f.name.toLowerCase() === (result.favorite_name || "").toLowerCase());
      if (!fav) { pushMsg({ role: "assistant", text: `No encuentro ninguna comida favorita llamada "${result.favorite_name}".` }); return; }
      const meal = { id: uid(), mealNumber: nextMealNumber(today_or(date)), date: todayStr(), source: "favorite", rawInput: rawText, items: fav.items.map((it) => ({ id: uid(), ...it })), createdAt: new Date().toISOString() };
      pushMsg({ role: "assistant", pendingMeal: meal });
      return;
    }

    if (result.intent === "save_favorite") {
      if (!lastCreatedMeal) { pushMsg({ role: "assistant", text: "Registra primero una comida para poder guardarla como favorita." }); return; }
      const name = result.favorite_name || "Favorita sin nombre";
      const fav = { id: uid(), name, items: lastCreatedMeal.items };
      setFavorites((prev) => [...prev, fav]);
      pushMsg({ role: "assistant", text: `Guardado. Ya puedes escribir "${name}" para volver a registrar esa comida.` });
      return;
    }

    if (result.intent === "weight_log") {
      if (result.weight_kg) {
        const weights = await loadJSON("weights", []);
        const updated = [...weights.filter((w) => w.date !== date), { date, kg: result.weight_kg }].sort((a, b) => a.date.localeCompare(b.date));
        await saveJSON("weights", updated);
        pushMsg({ role: "assistant", text: `Registrado: ${result.weight_kg} kg el ${humanDate(date)}.` });
      }
      return;
    }

    if (result.intent === "query") {
      const text = answerQuery(result, meals, goals);
      pushMsg({ role: "assistant", text });
      return;
    }

    // unclear
    pushMsg({ role: "assistant", text: result.clarification || "¿Puedes darme más detalles?" });
  }
  function today_or(d) { return todayStr(); }

  function confirmMeal(msgId, isEdit) {
    setChatMessages((prev) => prev.map((m) => {
      if (m.id !== msgId) return m;
      const meal = m.pendingMeal;
      setMealsForDate(meal.date, (list) => {
        if (isEdit) return list.map((x) => (x.id === meal.id ? { ...meal, editing: undefined } : x));
        return [...list, meal];
      });
      setLastCreatedMeal(meal);
      if (!isEdit && meal.rawInput) learnHabit(meal.rawInput, meal.items);
      return { ...m, confirmed: true };
    }));
  }

  function learnHabit(rawInput, items) {
    const key = normalizePhrase(rawInput);
    const wordCount = key.split(" ").filter(Boolean).length;
    if (!key || wordCount > 4) return; // solo aprendemos frases-disparador cortas ("café", "desayuno de siempre"...)
    setHabits((prev) => {
      const existing = prev[key];
      const occurrences = (existing?.occurrences || 0) + 1;
      return { ...prev, [key]: { items: items.map(({ id, ...rest }) => rest), occurrences, lastUsed: new Date().toISOString() } };
    });
  }
  function discardMeal(msgId) {
    setChatMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, discarded: true } : m)));
  }
  function changeQty(msgId, itemIdx, qty) {
    setChatMessages((prev) => prev.map((m) => {
      if (m.id !== msgId) return m;
      const items = [...m.pendingMeal.items];
      items[itemIdx] = { ...items[itemIdx], quantity_g: qty };
      return { ...m, pendingMeal: { ...m.pendingMeal, items } };
    }));
  }
  function removeItem(msgId, itemIdx) {
    setChatMessages((prev) => prev.map((m) => {
      if (m.id !== msgId) return m;
      const items = m.pendingMeal.items.filter((_, i) => i !== itemIdx);
      return { ...m, pendingMeal: { ...m.pendingMeal, items } };
    }));
  }

  return (
    <div className="flex flex-col" style={{ height: "100%" }}>
      {banner && (
        <div className="flex items-center justify-between" style={{ margin: "10px 14px 0", padding: "9px 12px", borderRadius: 14, background: colors.surfaceSoft, border: `1px solid ${colors.border}` }}>
          <div className="flex items-center gap-2" style={{ fontSize: 12.5, color: colors.text }}>
            <Sparkles size={14} color={colors.accent} /> {banner.text}
          </div>
          <button onClick={dismissBanner} style={{ color: colors.textDim, flexShrink: 0 }}><X size={14} /></button>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pt-4" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {chatMessages.length === 0 && (
          <div style={{ textAlign: "center", marginTop: 60, color: colors.textDim }}>
            <Sparkles size={26} style={{ margin: "0 auto 10px", opacity: 0.6 }} />
            <div style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>Habla, y lo registramos</div>
            <div style={{ fontSize: 13, marginTop: 6, maxWidth: 260, marginInline: "auto" }}>
              Escribe lo que has comido, por ejemplo: "he desayunado dos tostadas con aceite".
            </div>
          </div>
        )}
        {chatMessages.map((m) => (
          <div key={m.id} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
            {m.text && (
              <div style={{
                background: m.role === "user" ? colors.bubbleUser : colors.bubbleAI,
                color: m.role === "user" ? colors.bubbleUserText : colors.bubbleAIText,
                padding: "9px 13px", borderRadius: 16, fontSize: 14, lineHeight: 1.4
              }}>{m.text}</div>
            )}
            {m.pendingMeal && !m.discarded && (
              <MealCard
                meal={m.pendingMeal} colors={colors} pending={!m.confirmed}
                onConfirm={() => confirmMeal(m.id, m.isEdit)}
                onDiscard={() => discardMeal(m.id)}
                onChangeQty={(i, q) => changeQty(m.id, i, q)}
                onRemoveItem={(i) => removeItem(m.id, i)}
              />
            )}
            {m.confirmed && <div style={{ fontSize: 11, color: colors.textDim, marginTop: 3, marginLeft: 4 }}>✓ Registrado</div>}
            {m.discarded && <div style={{ fontSize: 11, color: colors.textDim, marginTop: 3, marginLeft: 4 }}>Descartado</div>}
            {m.retryText && (
              <button onClick={() => handleSend(m.retryText)} disabled={busy} className="flex items-center gap-1"
                style={{ fontSize: 11.5, color: colors.accent, marginTop: 4, marginLeft: 4, fontWeight: 600 }}>
                <Loader2 size={11} style={{ display: busy ? "inline" : "none" }} className="animate-spin" /> Reintentar
              </button>
            )}
          </div>
        ))}
        {busy && (
          <div style={{ alignSelf: "flex-start", color: colors.textDim, display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <Loader2 size={14} className="animate-spin" /> Interpretando…
          </div>
        )}
        {error && (
          <div style={{ alignSelf: "flex-start", color: colors.danger, display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
            <AlertCircle size={14} /> {error}
          </div>
        )}
        <div style={{ height: 8 }} />
      </div>
      <div style={{ padding: 12, borderTop: `1px solid ${colors.border}`, background: colors.bg }}>
        {suggestions.length > 0 && !busy && (
          <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 8, paddingBottom: 2 }}>
            {suggestions.map((s) => (
              <button key={normalizePhrase(s.name)} onClick={() => applySuggestion(s)} style={{
                flexShrink: 0, fontSize: 12.5, padding: "6px 12px", borderRadius: 999,
                background: colors.surfaceSoft, color: colors.text, whiteSpace: "nowrap", border: `1px solid ${colors.border}`
              }}>
                {s.name} <span style={{ color: colors.textDim }}>· {s.unit_label || `${s.quantity_g}g`}</span>
              </button>
            ))}
          </div>
        )}
        {(photo || photoLoading) && (
          <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
            {photo ? (
              <div style={{ position: "relative" }}>
                <img src={photo.preview} alt="Foto del plato" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 10, border: `1px solid ${colors.border}` }} />
                <button onClick={() => setPhoto(null)} aria-label="Quitar foto" style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, background: colors.text, color: colors.bg, display: "flex", alignItems: "center", justifyContent: "center" }}><X size={12} /></button>
              </div>
            ) : <Loader2 size={18} className="animate-spin" color={colors.textDim} />}
            <span style={{ fontSize: 12, color: colors.textDim }}>
              {photo ? "Foto lista. Añade cantidades o ingredientes si quieres afinar la estimación." : "Preparando foto…"}
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept="image/*" onChange={onPhotoPicked} style={{ display: "none" }} />
          <button onClick={() => fileRef.current && fileRef.current.click()} disabled={busy} aria-label="Añadir foto del plato" style={{
            width: 42, height: 42, borderRadius: 21, display: "flex", alignItems: "center", justifyContent: "center",
            background: colors.surfaceSoft, color: colors.accent, border: `1px solid ${colors.border}`, flexShrink: 0, opacity: busy ? 0.5 : 1
          }}>
            <Camera size={18} />
          </button>
          <input
            ref={inputRef}
            value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSend(input); }}
            placeholder={photo ? "Añade detalles (opcional)…" : "Escribe lo que has comido…"}
            style={{ flex: 1, background: colors.surfaceSoft, border: `1px solid ${colors.border}`, borderRadius: 20, padding: "10px 14px", fontSize: 14, color: colors.text }}
          />
          <button onClick={() => handleSend(input)} disabled={busy} style={{
            width: 42, height: 42, borderRadius: 21, display: "flex", alignItems: "center", justifyContent: "center",
            background: colors.accent, color: "#fff", flexShrink: 0, opacity: busy ? 0.5 : 1
          }}>
            <Send size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}

function answerQuery(result, meals, goals) {
  const date = result.query_date_or_range && /^\d{4}-\d{2}-\d{2}$/.test(result.query_date_or_range) ? result.query_date_or_range : todayStr();
  const list = meals[date] || [];
  const totals = list.reduce((acc, m) => {
    const t = computeMealTotals(m.items);
    acc.kcal += t.kcal; acc.protein += t.protein; acc.fat += t.fat; acc.carbs += t.carbs;
    return acc;
  }, { kcal: 0, protein: 0, fat: 0, carbs: 0 });

  switch (result.query_type) {
    case "kcal_consumed": return `Llevas ${round1(totals.kcal)} kcal el ${humanDate(date)}.`;
    case "kcal_remaining": return `Te quedan ${round1(Math.max(0, goals.kcal - totals.kcal))} kcal de tu objetivo de ${goals.kcal} kcal.`;
    case "protein_consumed": return `Llevas ${round1(totals.protein)} g de proteína${goals.protein ? ` de tu objetivo de ${goals.protein} g` : ""}.`;
    case "fat_consumed": return `Llevas ${round1(totals.fat)} g de grasas${goals.fat ? ` de tu objetivo de ${goals.fat} g` : ""}.`;
    case "carbs_consumed": return `Llevas ${round1(totals.carbs)} g de hidratos${goals.carbs ? ` de tu objetivo de ${goals.carbs} g` : ""}.`;
    case "meals_list":
      if (!list.length) return `No hay comidas registradas el ${humanDate(date)}.`;
      return list.map((m) => `Comida ${m.mealNumber}: ${m.items.map((i) => i.name).join(", ")}`).join("\n");
    case "weekly_margin": {
      const dates = weekDates(new Date(date));
      const weeklyTarget = goals.kcal * 7;
      const consumed = dates.reduce((s, d) => s + (meals[d] || []).reduce((s2, m) => s2 + computeMealTotals(m.items).kcal, 0), 0);
      return `Objetivo semanal: ${weeklyTarget} kcal. Llevas consumidas ${round1(consumed)} kcal. Margen disponible: ${round1(weeklyTarget - consumed)} kcal.`;
    }
    case "dinner_suggestion": {
      const remProtein = Math.max(0, (goals.protein || 0) - totals.protein);
      const remKcal = Math.max(0, goals.kcal - totals.kcal);
      if (remProtein > 25) return `Te quedan ${round1(remKcal)} kcal y ${round1(remProtein)} g de proteína por cubrir: una buena opción sería pescado blanco o pechuga de pollo con verduras.`;
      return `Te quedan ${round1(remKcal)} kcal disponibles hoy. Algo ligero como una ensalada con huevo o un salteado de verduras encajaría bien.`;
    }
    default:
      return `Hoy llevas ${round1(totals.kcal)} kcal, P ${round1(totals.protein)}g · G ${round1(totals.fat)}g · H ${round1(totals.carbs)}g.`;
  }
}

// ================= PANTALLA: DASHBOARD =================
function DashboardScreen({ colors, goals, meals }) {
  const today = todayStr();
  const todayMeals = meals[today] || [];
  const totals = todayMeals.reduce((acc, m) => {
    const t = computeMealTotals(m.items);
    acc.kcal += t.kcal; acc.protein += t.protein; acc.fat += t.fat; acc.carbs += t.carbs;
    return acc;
  }, { kcal: 0, protein: 0, fat: 0, carbs: 0 });

  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState(null);
  useEffect(() => { (async () => setSummary(await loadJSON(`daily-summary-${today}`, null)))(); }, [today]);

  async function generateSummary() {
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const deviationPct = round1(((totals.kcal - goals.kcal) / goals.kcal) * 100);
      const prompt = `Fecha: ${humanDate(today)}.
Calorías consumidas: ${round1(totals.kcal)} kcal. Objetivo: ${goals.kcal} kcal. Desviación: ${deviationPct}%.
Proteína: ${round1(totals.protein)} g${goals.protein ? ` (objetivo ${goals.protein} g)` : ""}.
Grasas: ${round1(totals.fat)} g${goals.fat ? ` (objetivo ${goals.fat} g)` : ""}.
Hidratos: ${round1(totals.carbs)} g${goals.carbs ? ` (objetivo ${goals.carbs} g)` : ""}.
Comidas registradas: ${todayMeals.length}.
Escribe una valoración automática breve del día usando solo estos datos.`;
      const text = await callClaudeText(prompt);
      setSummary(text);
      await saveJSON(`daily-summary-${today}`, text);
    } catch (e) {
      console.error(e);
      setSummaryError(e?.message || "No se pudo generar el resumen.");
    }
    setSummaryLoading(false);
  }

  const dates = weekDates(new Date());
  const weeklyTarget = goals.kcal * 7;
  const consumedThisWeek = dates.reduce((s, d) => s + (meals[d] || []).reduce((s2, m) => s2 + computeMealTotals(m.items).kcal, 0), 0);
  const remainingWeek = weeklyTarget - consumedThisWeek;
  const todayIdx = dates.indexOf(today);
  const daysLeft = Math.max(1, 7 - todayIdx);
  const marginPerDay = remainingWeek / daysLeft;
  const macroGoals = effectiveMacroGoals(goals);

  return (
    <div className="overflow-y-auto px-4 py-5" style={{ height: "100%" }}>
      <div style={{ fontSize: 13, color: colors.textDim, marginBottom: 2 }}>{humanDate(today)}</div>
      <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Tu progreso de hoy</div>

      <Card colors={colors} style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
        <Ring value={totals.kcal} max={goals.kcal} color={colors.kcal} trackColor={colors.surfaceSoft} label="kcal" sub={`de ${goals.kcal}`} />
      </Card>

      <Card colors={colors} style={{ marginBottom: 16 }}>
        <MacroBar label={MACRO_LABELS.protein} value={totals.protein} max={macroGoals.protein} color={colors.protein} colors={colors} />
        <MacroBar label={MACRO_LABELS.fat} value={totals.fat} max={macroGoals.fat} color={colors.fat} colors={colors} />
        <MacroBar label={MACRO_LABELS.carbs} value={totals.carbs} max={macroGoals.carbs} color={colors.carbs} colors={colors} />
        {(!goals.protein || !goals.fat || !goals.carbs) && (
          <div style={{ fontSize: 11, color: colors.textDim, marginTop: 2 }}>
            Objetivo de macros orientativo (30% proteína / 30% grasa / 40% hidratos de tu objetivo de kcal). Puedes fijar el tuyo en Ajustes.
          </div>
        )}
      </Card>

      <Card colors={colors} style={{ marginBottom: 16, background: remainingWeek >= 0 ? colors.accentTint : colors.surface }}>
        <div className="flex items-center gap-2 mb-1">
          <Flame size={14} color={remainingWeek >= 0 ? colors.accentTintText : colors.danger} />
          <span style={{ fontSize: 12.5, fontWeight: 500, color: remainingWeek >= 0 ? colors.accentTintText : colors.textDim }}>Banco calórico semanal</span>
        </div>
        {remainingWeek >= 0 ? (
          <>
            <div style={{ fontSize: 22, fontWeight: 600, color: colors.text }}>
              {round1(marginPerDay)} kcal<span style={{ fontSize: 13, fontWeight: 400, color: colors.accentTintText }}> / día</span>
            </div>
            <div style={{ fontSize: 11.5, color: colors.accentTintText, marginBottom: 8 }}>disponibles sin superar el objetivo semanal</div>
          </>
        ) : (
          <div style={{ fontSize: 15, fontWeight: 600, color: colors.danger, marginBottom: 8 }}>
            Has superado el objetivo en {round1(-remainingWeek)} kcal
          </div>
        )}
        <div style={{ fontSize: 11, color: remainingWeek >= 0 ? colors.accentTintText : colors.textDim, paddingTop: 8, borderTop: `1px solid ${remainingWeek >= 0 ? "rgba(0,0,0,0.08)" : colors.border}` }}>
          Objetivo semanal {weeklyTarget} kcal · consumido {round1(consumedThisWeek)} kcal
        </div>
      </Card>

      <Card colors={colors}>
        <div className="flex items-center justify-between mb-2">
          <span style={{ fontWeight: 600, fontSize: 14 }}>Comidas de hoy</span>
          <span style={{ fontSize: 12, color: colors.textDim }}>{todayMeals.length}</span>
        </div>
        {todayMeals.length === 0 && <div style={{ fontSize: 13, color: colors.textDim }}>Aún no has registrado ninguna comida hoy.</div>}
        {todayMeals.map((m) => {
          const t = computeMealTotals(m.items);
          return (
            <div key={m.id} style={{ padding: "8px 0", borderTop: `1px solid ${colors.border}` }}>
              <div className="flex justify-between items-center" style={{ fontSize: 13.5, fontWeight: 500 }}>
                <span className="flex items-center gap-2">
                  <span style={{
                    width: 20, height: 20, borderRadius: "50%", background: colors.surfaceSoft, color: colors.text,
                    fontSize: 10.5, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0
                  }}>{m.mealNumber}</span>
                  Comida {m.mealNumber}
                </span>
                <span>{round1(t.kcal)} kcal</span>
              </div>
              <div style={{ fontSize: 11.5, color: colors.textDim, marginBottom: 3, marginLeft: 28 }}>P {round1(t.protein)}g · G {round1(t.fat)}g · H {round1(t.carbs)}g</div>
              {m.items.map((it, i) => {
                const a = computeItemAbs(it);
                return (
                  <div key={it.id || i} className="flex justify-between" style={{ fontSize: 11, color: colors.textDim, padding: "1px 0 1px 8px" }}>
                    <span>· {it.name} ({it.unit_label ? `${it.unit_label}, ${it.quantity_g}g` : `${it.quantity_g}g`})</span>
                    <span>{a.kcal} kcal · P{a.protein} G{a.fat} H{a.carbs}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </Card>

      <Card colors={colors} style={{ marginTop: 16 }}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2"><Sparkles size={15} color={colors.accent} /><span style={{ fontWeight: 600, fontSize: 14 }}>Resumen del día</span></div>
          <button onClick={generateSummary} disabled={summaryLoading || todayMeals.length === 0} style={{
            fontSize: 12, background: colors.surfaceSoft, padding: "5px 10px", borderRadius: 999, color: colors.text, opacity: (summaryLoading || todayMeals.length === 0) ? 0.5 : 1
          }}>
            {summaryLoading ? <Loader2 size={12} className="animate-spin" /> : summary ? "Regenerar" : "Generar"}
          </button>
        </div>
        {!summary && !summaryLoading && <div style={{ fontSize: 13, color: colors.textDim }}>Genera una valoración automática de tu día con lo registrado hasta ahora.</div>}
        {summary && <div style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-line" }}>{summary}</div>}
        {summaryError && <div style={{ fontSize: 12, color: colors.danger, marginTop: 6 }}>No se pudo generar: {summaryError}</div>}
      </Card>
    </div>
  );
}

// ---------- Editor de comida (usado desde el Historial) ----------
// ---------- Formulario reutilizable para añadir un alimento manualmente ----------
// Admite dos modos: "por 100 g" (clásico) o "por ración completa" (ej. "1 plátano",
// "1 yogur"): en este segundo modo los valores introducidos son el total de esa
// ración, y se guardan internamente como si fueran "valores por 100 g de una ración
// de 100 unidades", fijando quantity_g=100 — así el cálculo (valor × cantidad/100)
// da exactamente el total introducido, sin necesitar un modelo de datos nuevo.
function AddFoodForm({ colors, onAdd, onCancel }) {
  const [mode, setMode] = useState("per100");
  const [name, setName] = useState("");
  const [portionLabel, setPortionLabel] = useState("");
  const [quantity, setQuantity] = useState("");
  const [kcal, setKcal] = useState("");
  const [protein, setProtein] = useState("");
  const [fat, setFat] = useState("");
  const [carbs, setCarbs] = useState("");

  function submit() {
    if (!name) return;
    if (mode === "per100") {
      if (!quantity) return;
      onAdd({
        id: uid(), name, quantity_g: Number(quantity), estimated: false,
        kcal_per_100g: Number(kcal) || 0, protein_per_100g: Number(protein) || 0,
        fat_per_100g: Number(fat) || 0, carbs_per_100g: Number(carbs) || 0, unit_label: ""
      });
    } else {
      onAdd({
        id: uid(), name, quantity_g: 100, estimated: false,
        kcal_per_100g: Number(kcal) || 0, protein_per_100g: Number(protein) || 0,
        fat_per_100g: Number(fat) || 0, carbs_per_100g: Number(carbs) || 0,
        unit_label: portionLabel || "1 ración"
      });
    }
  }

  return (
    <div style={{ marginTop: 12, padding: 10, borderRadius: 12, background: colors.surfaceSoft }}>
      <div className="flex gap-2 mb-2">
        <button onClick={() => setMode("per100")} style={{ flex: 1, fontSize: 11.5, padding: "6px 0", borderRadius: 8, fontWeight: 600, background: mode === "per100" ? colors.accent : colors.surface, color: mode === "per100" ? "#fff" : colors.text }}>Por 100 g</button>
        <button onClick={() => setMode("portion")} style={{ flex: 1, fontSize: 11.5, padding: "6px 0", borderRadius: 8, fontWeight: 600, background: mode === "portion" ? colors.accent : colors.surface, color: mode === "portion" ? "#fff" : colors.text }}>Por ración completa</button>
      </div>
      <input placeholder="Nombre (ej. Plátano)" value={name} onChange={(e) => setName(e.target.value)}
        style={{ width: "100%", marginBottom: 6, padding: "6px 8px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.surface, color: colors.text, fontSize: 13 }} />
      {mode === "portion" && (
        <input placeholder='Etiqueta de la ración (ej. "1 plátano", "1 yogur")' value={portionLabel} onChange={(e) => setPortionLabel(e.target.value)}
          style={{ width: "100%", marginBottom: 6, padding: "6px 8px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.surface, color: colors.text, fontSize: 12.5 }} />
      )}
      <div className="flex gap-2" style={{ marginBottom: 6 }}>
        {mode === "per100" && (
          <input type="number" placeholder="Cantidad (g)" value={quantity} onChange={(e) => setQuantity(e.target.value)}
            style={{ flex: 1, padding: "6px 8px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.surface, color: colors.text, fontSize: 12 }} />
        )}
        <input type="number" placeholder={mode === "per100" ? "kcal/100g" : "kcal (ración)"} value={kcal} onChange={(e) => setKcal(e.target.value)}
          style={{ flex: 1, padding: "6px 8px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.surface, color: colors.text, fontSize: 12 }} />
      </div>
      <div className="flex gap-2" style={{ marginBottom: 8 }}>
        <input type="number" placeholder={mode === "per100" ? "Prot/100g" : "Prot (g)"} value={protein} onChange={(e) => setProtein(e.target.value)}
          style={{ flex: 1, padding: "6px 8px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.surface, color: colors.text, fontSize: 12 }} />
        <input type="number" placeholder={mode === "per100" ? "Grasa/100g" : "Grasa (g)"} value={fat} onChange={(e) => setFat(e.target.value)}
          style={{ flex: 1, padding: "6px 8px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.surface, color: colors.text, fontSize: 12 }} />
        <input type="number" placeholder={mode === "per100" ? "Hidr/100g" : "Hidr (g)"} value={carbs} onChange={(e) => setCarbs(e.target.value)}
          style={{ flex: 1, padding: "6px 8px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.surface, color: colors.text, fontSize: 12 }} />
      </div>
      <div className="flex gap-2">
        <button onClick={submit} style={{ flex: 1, background: colors.accent, color: "#fff", padding: "7px 0", borderRadius: 10, fontSize: 12.5, fontWeight: 600 }}>Añadir</button>
        <button onClick={onCancel} style={{ flex: 1, background: colors.surface, color: colors.text, padding: "7px 0", borderRadius: 10, fontSize: 12.5 }}>Cancelar</button>
      </div>
    </div>
  );
}

function MealEditModal({ meal, colors, onClose, onSave, onDelete }) {
  const [items, setItems] = useState(meal.items.map((it) => ({ ...it })));
  const [showAddForm, setShowAddForm] = useState(meal.items.length === 0);

  function updateQty(i, qty) { setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, quantity_g: qty } : it))); }
  function removeItem(i) { setItems((prev) => prev.filter((_, idx) => idx !== i)); }
  function addItem(item) { setItems((prev) => [...prev, item]); setShowAddForm(false); }

  const totals = computeMealTotals(items);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: colors.surface, borderRadius: "20px 20px 0 0", padding: 18, width: "100%", maxWidth: 480, maxHeight: "85vh", overflowY: "auto" }}>
        <div className="flex items-center justify-between mb-3">
          <div style={{ fontWeight: 600, fontSize: 15 }}>{meal.isNew ? "Nueva comida" : `Editar Comida ${meal.mealNumber}`} · {humanDate(meal.date).split(",")[0]}</div>
          <button onClick={onClose} style={{ color: colors.textDim }}><X size={18} /></button>
        </div>

        {items.map((it, i) => {
          const a = computeItemAbs(it);
          return (
            <div key={it.id || i} className="flex items-center justify-between" style={{ padding: "8px 0", borderTop: i === 0 ? "none" : `1px solid ${colors.border}` }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5 }}>{it.name}</div>
                {it.unit_label && <div style={{ fontSize: 11, color: colors.textDim }}>{it.unit_label}</div>}
                <div style={{ fontSize: 11.5, color: colors.textDim }}>{a.kcal} kcal · P {a.protein}g · G {a.fat}g · H {a.carbs}g</div>
              </div>
              <div className="flex items-center gap-1">
                <input type="number" value={it.quantity_g} onChange={(e) => updateQty(i, Number(e.target.value))}
                  style={{ width: 56, fontSize: 12, padding: "4px 6px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.surfaceSoft, color: colors.text }} />
                <span style={{ fontSize: 11, color: colors.textDim }}>g</span>
                <button onClick={() => removeItem(i)} style={{ color: colors.danger, padding: 4 }}><Trash2 size={14} /></button>
              </div>
            </div>
          );
        })}
        {items.length === 0 && <div style={{ fontSize: 13, color: colors.textDim, padding: "10px 0" }}>Sin alimentos. Añade uno o elimina la comida completa.</div>}

        <div className="flex justify-between items-center mt-3 pt-2" style={{ borderTop: `1px solid ${colors.border}`, fontWeight: 600, fontSize: 13.5 }}>
          <span>Total</span><span>{round1(totals.kcal)} kcal</span>
        </div>

        {!showAddForm ? (
          <button onClick={() => setShowAddForm(true)} className="flex items-center gap-1" style={{ marginTop: 12, fontSize: 12.5, color: colors.accent }}>
            <Plus size={14} /> Añadir alimento manualmente
          </button>
        ) : (
          <AddFoodForm colors={colors} onAdd={addItem} onCancel={() => setShowAddForm(false)} />
        )}

        <div className="flex gap-2 mt-4">
          <button onClick={() => items.length > 0 && onSave(items)} disabled={items.length === 0} className="flex items-center justify-center gap-1"
            style={{ flex: 1, background: colors.accent, color: "#fff", padding: "9px 0", borderRadius: 12, fontSize: 13.5, fontWeight: 600, opacity: items.length === 0 ? 0.5 : 1 }}>
            <Check size={15} /> {meal.isNew ? "Crear comida" : "Guardar cambios"}
          </button>
          <button onClick={onClose} style={{ flex: 1, background: colors.surfaceSoft, color: colors.text, padding: "9px 0", borderRadius: 12, fontSize: 13.5, fontWeight: 600 }}>Cancelar</button>
        </div>
        {!meal.isNew && (
          <button onClick={onDelete} className="flex items-center justify-center gap-1" style={{ width: "100%", marginTop: 8, color: colors.danger, padding: "8px 0", fontSize: 12.5 }}>
            <Trash2 size={14} /> Eliminar esta comida completa
          </button>
        )}
      </div>
    </div>
  );
}

// ================= PANTALLA: HISTORIAL =================
function HistoryScreen({ colors, meals, goals, setMealsForDate }) {
  const [mode, setMode] = useState("week"); // day | week | month
  const [anchor, setAnchor] = useState(new Date());
  const [weeklyReport, setWeeklyReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState(null);
  const [editingMeal, setEditingMeal] = useState(null);

  const dateList = (() => {
    if (mode === "day") return [toDateStr(anchor)];
    if (mode === "week") return weekDates(anchor);
    const y = anchor.getFullYear(), mo = anchor.getMonth();
    const days = new Date(y, mo + 1, 0).getDate();
    return Array.from({ length: days }, (_, i) => toDateStr(new Date(y, mo, i + 1)));
  })();

  const chartData = dateList.map((d) => ({
    day: new Date(d + "T00:00:00").toLocaleDateString("es-ES", { day: "2-digit", month: mode === "month" ? "2-digit" : undefined, weekday: mode === "week" ? "short" : undefined }),
    kcal: round1((meals[d] || []).reduce((s, m) => s + computeMealTotals(m.items).kcal, 0))
  }));

  function shift(dir) {
    const d = new Date(anchor);
    if (mode === "day") d.setDate(d.getDate() + dir);
    else if (mode === "week") d.setDate(d.getDate() + dir * 7);
    else d.setMonth(d.getMonth() + dir);
    if (dir === 1) {
      const candidateStart = mode === "day" ? toDateStr(d) : mode === "week" ? weekDates(d)[0] : toDateStr(new Date(d.getFullYear(), d.getMonth(), 1));
      if (candidateStart > todayStr()) return; // no navegar a periodos enteramente futuros
    }
    setAnchor(d);
  }
  const canGoForward = dateList[dateList.length - 1] < todayStr();

  const weekKey = mode === "week" ? `week-report-${dateList[0]}` : null;
  useEffect(() => {
    if (!weekKey) return;
    setWeeklyReport(null);
    (async () => setWeeklyReport(await loadJSON(weekKey, null)))();
  }, [weekKey]);

  const weekStats = (() => {
    if (mode !== "week") return null;
    const perDay = dateList.map((d) => {
      const t = (meals[d] || []).reduce((acc, m) => {
        const tt = computeMealTotals(m.items);
        acc.kcal += tt.kcal; acc.protein += tt.protein; acc.fat += tt.fat; acc.carbs += tt.carbs;
        return acc;
      }, { kcal: 0, protein: 0, fat: 0, carbs: 0 });
      return { date: d, ...t };
    });
    const withData = perDay.filter((d) => d.kcal > 0);
    if (!withData.length) return null;
    const avgKcal = withData.reduce((s, d) => s + d.kcal, 0) / withData.length;
    const avgProtein = withData.reduce((s, d) => s + d.protein, 0) / withData.length;
    const avgFat = withData.reduce((s, d) => s + d.fat, 0) / withData.length;
    const avgCarbs = withData.reduce((s, d) => s + d.carbs, 0) / withData.length;
    const macroGoals = effectiveMacroGoals(goals);
    const best = withData.reduce((a, b) => (Math.abs(a.kcal - goals.kcal) < Math.abs(b.kcal - goals.kcal) ? a : b));
    const worst = withData.reduce((a, b) => (Math.abs(a.kcal - goals.kcal) > Math.abs(b.kcal - goals.kcal) ? a : b));
    const withinGoal = withData.filter((d) => d.kcal <= goals.kcal * 1.05).length;
    const pctWithin = round1((withinGoal / withData.length) * 100);
    return {
      avgKcal: round1(avgKcal), avgProtein: round1(avgProtein), avgFat: round1(avgFat), avgCarbs: round1(avgCarbs),
      macroGoals, best, worst, pctWithin, daysLogged: withData.length
    };
  })();

  async function generateWeeklyReport() {
    if (!weekStats || !weekKey) return;
    setReportLoading(true);
    setReportError(null);
    try {
      const macroLine = (label, avg, target) => {
        const pct = round1((avg / target) * 100);
        const status = pct >= 90 && pct <= 110 ? "cumplido" : pct < 90 ? "por debajo del objetivo" : "por encima del objetivo";
        return `${label}: promedio diario ${avg} g frente a un objetivo de ${target} g/día (${pct}%, ${status}).`;
      };
      const prompt = `Informe semanal (${humanDate(dateList[0])} a ${humanDate(dateList[6])}), semana definida de jueves a miércoles.
Objetivo diario: ${goals.kcal} kcal (semanal: ${goals.kcal * 7} kcal).
Promedio diario real: ${weekStats.avgKcal} kcal.
${macroLine("Proteína", weekStats.avgProtein, weekStats.macroGoals.protein)}
${macroLine("Grasas", weekStats.avgFat, weekStats.macroGoals.fat)}
${macroLine("Hidratos", weekStats.avgCarbs, weekStats.macroGoals.carbs)}
Mejor día (más cercano al objetivo de kcal): ${humanDate(weekStats.best.date)} con ${round1(weekStats.best.kcal)} kcal.
Peor día (más alejado del objetivo de kcal): ${humanDate(weekStats.worst.date)} con ${round1(weekStats.worst.kcal)} kcal.
Porcentaje de días dentro del objetivo de kcal (±5%): ${weekStats.pctWithin}%.
Días con registro: ${weekStats.daysLogged} de 7.
Escribe conclusiones breves de la semana usando solo estos datos, incluyendo explícitamente si se ha cumplido o no cada macro (proteína, grasas, hidratos) en el promedio semanal.`;
      const text = await callClaudeText(prompt);
      setWeeklyReport(text);
      await saveJSON(weekKey, text);
    } catch (e) {
      console.error(e);
      setReportError(e?.message || "No se pudo generar el informe.");
    }
    setReportLoading(false);
  }

  function saveMealEdits(newItems) {
    if (!editingMeal) return;
    if (editingMeal.isNew) {
      setMealsForDate(editingMeal.date, (list) => [...list, { ...editingMeal, items: newItems, isNew: undefined }]);
    } else {
      setMealsForDate(editingMeal.date, (list) => list.map((m) => (m.id === editingMeal.id ? { ...m, items: newItems } : m)));
    }
    setEditingMeal(null);
  }
  function deleteMeal() {
    if (!editingMeal) return;
    if (!editingMeal.isNew) {
      setMealsForDate(editingMeal.date, (list) => list.filter((m) => m.id !== editingMeal.id));
    }
    setEditingMeal(null);
  }
  function isEditableDate(d) {
    const today = todayStr();
    if (d > today) return false; // nunca días futuros
    const diffDays = Math.round((new Date(today) - new Date(d)) / 86400000);
    return diffDays <= 10;
  }
  function addMealToDay(d) {
    const existing = meals[d] || [];
    const nextNumber = existing.length ? Math.max(...existing.map((m) => m.mealNumber)) + 1 : 1;
    setEditingMeal({ id: uid(), mealNumber: nextNumber, date: d, items: [], isNew: true });
  }

  return (
    <div className="overflow-y-auto px-4 py-5" style={{ height: "100%" }}>
      <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>Historial</div>
      <div className="flex gap-2 mb-3">
        {["day", "week", "month"].map((m) => (
          <button key={m} onClick={() => setMode(m)} style={{
            padding: "6px 12px", borderRadius: 999, fontSize: 12.5, fontWeight: 500,
            background: mode === m ? colors.accent : colors.surfaceSoft, color: mode === m ? "#fff" : colors.text
          }}>{m === "day" ? "Día" : m === "week" ? "Semana" : "Mes"}</button>
        ))}
      </div>
      <div className="flex items-center justify-between mb-4">
        <button onClick={() => shift(-1)} style={{ color: colors.textDim }}><ChevronLeft size={20} /></button>
        <span style={{ fontSize: 13, fontWeight: 500 }}>
          {mode === "day" ? humanDate(toDateStr(anchor)) : mode === "week" ? `Semana del ${humanDate(dateList[0]).split(",")[1]}` : anchor.toLocaleDateString("es-ES", { month: "long", year: "numeric" })}
        </span>
        <button onClick={() => shift(1)} disabled={!canGoForward} style={{ color: colors.textDim, opacity: canGoForward ? 1 : 0.3 }}><ChevronRight size={20} /></button>
      </div>

      <Card colors={colors} style={{ marginBottom: 16 }}>
        <div style={{ width: "100%", height: 160 }}>
          <ResponsiveContainer>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={colors.border} vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: colors.textDim }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: colors.textDim }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="kcal" fill={colors.accent} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {mode === "week" && (() => {
        const currentWeekStart = weekDates(new Date())[0];
        const lastWeekAnchor = new Date(); lastWeekAnchor.setDate(lastWeekAnchor.getDate() - 7);
        const lastWeekStart = weekDates(lastWeekAnchor)[0];
        const isCurrentWeek = dateList[0] === currentWeekStart;
        const isLastWeek = dateList[0] === lastWeekStart;
        return (
          <div className="flex gap-2 mb-3">
            <button onClick={() => setAnchor(new Date())} style={{
              fontSize: 12, padding: "6px 12px", borderRadius: 999, fontWeight: 500,
              background: isCurrentWeek ? colors.accent : colors.surfaceSoft, color: isCurrentWeek ? "#fff" : colors.text
            }}>Semana actual</button>
            <button onClick={() => setAnchor(lastWeekAnchor)} style={{
              fontSize: 12, padding: "6px 12px", borderRadius: 999, fontWeight: 500,
              background: isLastWeek ? colors.accent : colors.surfaceSoft, color: isLastWeek ? "#fff" : colors.text
            }}>Semana pasada</button>
          </div>
        );
      })()}

      {mode === "week" && weekStats && (
        <Card colors={colors} style={{ marginBottom: 16 }}>
          <div className="flex items-center justify-between mb-2">
            <span style={{ fontWeight: 600, fontSize: 14 }}>Informe semanal</span>
            <button onClick={generateWeeklyReport} disabled={reportLoading} style={{
              fontSize: 12, background: colors.surfaceSoft, padding: "5px 10px", borderRadius: 999, color: colors.text, opacity: reportLoading ? 0.5 : 1
            }}>
              {reportLoading ? <Loader2 size={12} className="animate-spin" /> : weeklyReport ? "Regenerar" : "Generar conclusiones"}
            </button>
          </div>
          <div className="flex justify-between" style={{ fontSize: 12.5, color: colors.textDim, marginBottom: 8 }}>
            <span>Media diaria: <b style={{ color: colors.text }}>{weekStats.avgKcal} kcal</b></span>
            <span>Días en objetivo: <b style={{ color: colors.text }}>{weekStats.pctWithin}%</b></span>
          </div>
          <div style={{ fontSize: 12, color: colors.textDim }}>
            Mejor día: <b style={{ color: colors.accent }}>{humanDate(weekStats.best.date).split(",")[0]}</b> · Peor día: <b style={{ color: colors.danger }}>{humanDate(weekStats.worst.date).split(",")[0]}</b>
          </div>
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${colors.border}` }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Cumplimiento de macros (media diaria)</div>
            {[
              { label: "Proteína", avg: weekStats.avgProtein, target: weekStats.macroGoals.protein },
              { label: "Grasas", avg: weekStats.avgFat, target: weekStats.macroGoals.fat },
              { label: "Hidratos", avg: weekStats.avgCarbs, target: weekStats.macroGoals.carbs }
            ].map(({ label, avg, target }) => {
              const pct = round1((avg / target) * 100);
              const ok = pct >= 90 && pct <= 110;
              return (
                <div key={label} className="flex justify-between" style={{ fontSize: 12, padding: "2px 0" }}>
                  <span style={{ color: colors.textDim }}>{label}</span>
                  <span style={{ color: ok ? colors.accent : colors.danger, fontWeight: 500 }}>
                    {avg}g / {target}g ({pct}%) {ok ? "✓" : "⚠"}
                  </span>
                </div>
              );
            })}
          </div>
          {weeklyReport && <div style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-line", marginTop: 10, paddingTop: 10, borderTop: `1px solid ${colors.border}` }}>{weeklyReport}</div>}
          {reportError && <div style={{ fontSize: 12, color: colors.danger, marginTop: 8 }}>No se pudo generar: {reportError}</div>}
        </Card>
      )}

      {mode === "week" && !weekStats && (
        <Card colors={colors} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: colors.textDim }}>No hay comidas registradas en esta semana, así que no hay datos suficientes para generar un informe.</div>
        </Card>
      )}

      {dateList.slice().reverse().map((d) => {
        if (d > todayStr()) return null; // nunca mostrar días futuros
        const list = meals[d] || [];
        if (!list.length && mode === "month") return null; // en vista mes seguimos ocultando días vacíos para no saturar
        const t = list.reduce((acc, m) => {
          const tt = computeMealTotals(m.items);
          acc.kcal += tt.kcal; acc.protein += tt.protein; acc.fat += tt.fat; acc.carbs += tt.carbs;
          return acc;
        }, { kcal: 0, protein: 0, fat: 0, carbs: 0 });
        return (
          <Card key={d} colors={colors} style={{ marginBottom: 10 }}>
            <div className="flex justify-between items-center mb-1">
              <span style={{ fontWeight: 600, fontSize: 13.5, textTransform: "capitalize" }}>{humanDate(d)}</span>
              {list.length > 0
                ? <span style={{ fontSize: 12.5, color: t.kcal > goals.kcal ? colors.danger : colors.accent }}>{round1(t.kcal)} / {goals.kcal} kcal</span>
                : <span style={{ fontSize: 12, color: colors.textDim }}>Sin comidas</span>}
            </div>
            {list.length > 0 && (
              <div style={{ height: 6, borderRadius: 999, background: colors.surfaceSoft, overflow: "hidden", marginBottom: 8 }}>
                <div style={{
                  width: `${Math.min(100, (t.kcal / goals.kcal) * 100)}%`, height: "100%", borderRadius: 999,
                  background: t.kcal > goals.kcal ? colors.danger : colors.accent, transition: "width 0.4s ease"
                }} />
              </div>
            )}
            {list.map((m) => (
              isEditableDate(d) ? (
                <button key={m.id} onClick={() => setEditingMeal(m)} className="w-full text-left" style={{ fontSize: 12, color: colors.textDim, padding: "5px 0", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span>Comida {m.mealNumber}: {m.items.map((i) => i.name).join(", ")}</span>
                  <ChevronRight size={13} style={{ flexShrink: 0, opacity: 0.5 }} />
                </button>
              ) : (
                <div key={m.id} style={{ fontSize: 12, color: colors.textDim, padding: "5px 0" }}>
                  Comida {m.mealNumber}: {m.items.map((i) => i.name).join(", ")}
                </div>
              )
            ))}
            {isEditableDate(d) && (
              <button onClick={() => addMealToDay(d)} className="flex items-center gap-1" style={{ fontSize: 12, color: colors.accent, padding: "5px 0", marginTop: list.length ? 2 : 0 }}>
                <Plus size={13} /> Añadir comida a este día
              </button>
            )}
          </Card>
        );
      })}

      {editingMeal && (
        <MealEditModal
          meal={editingMeal} colors={colors}
          onClose={() => setEditingMeal(null)}
          onSave={saveMealEdits}
          onDelete={deleteMeal}
        />
      )}
    </div>
  );
}

// ---------- Editor de comida favorita (crear o modificar manualmente) ----------
function FavoriteEditModal({ favorite, colors, onClose, onSave, onDelete }) {
  const isNew = !favorite;
  const [name, setName] = useState(favorite ? favorite.name : "");
  const [items, setItems] = useState(favorite ? favorite.items.map((it) => ({ ...it })) : []);
  const [showAddForm, setShowAddForm] = useState(isNew);

  function updateQty(i, qty) { setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, quantity_g: qty } : it))); }
  function removeItem(i) { setItems((prev) => prev.filter((_, idx) => idx !== i)); }
  function addItem(item) { setItems((prev) => [...prev, item]); setShowAddForm(false); }

  const totals = computeMealTotals(items);
  const canSave = name.trim().length > 0 && items.length > 0;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: colors.surface, borderRadius: "20px 20px 0 0", padding: 18, width: "100%", maxWidth: 480, maxHeight: "85vh", overflowY: "auto" }}>
        <div className="flex items-center justify-between mb-3">
          <div style={{ fontWeight: 600, fontSize: 15 }}>{isNew ? "Nueva comida favorita" : "Editar comida favorita"}</div>
          <button onClick={onClose} style={{ color: colors.textDim }}><X size={18} /></button>
        </div>

        <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 4 }}>Nombre</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder='Por ejemplo: "Café"'
          style={{ width: "100%", marginBottom: 14, padding: "8px 10px", borderRadius: 10, border: `1px solid ${colors.border}`, background: colors.surfaceSoft, color: colors.text, fontSize: 14 }} />

        <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 4 }}>Composición</div>
        {items.map((it, i) => {
          const a = computeItemAbs(it);
          return (
            <div key={it.id || i} className="flex items-center justify-between" style={{ padding: "8px 0", borderTop: i === 0 ? "none" : `1px solid ${colors.border}` }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5 }}>{it.name}</div>
                {it.unit_label && <div style={{ fontSize: 11, color: colors.textDim }}>{it.unit_label}</div>}
                <div style={{ fontSize: 11.5, color: colors.textDim }}>{a.kcal} kcal · P {a.protein}g · G {a.fat}g · H {a.carbs}g</div>
              </div>
              <div className="flex items-center gap-1">
                <input type="number" value={it.quantity_g} onChange={(e) => updateQty(i, Number(e.target.value))}
                  style={{ width: 56, fontSize: 12, padding: "4px 6px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.surfaceSoft, color: colors.text }} />
                <span style={{ fontSize: 11, color: colors.textDim }}>g</span>
                <button onClick={() => removeItem(i)} style={{ color: colors.danger, padding: 4 }}><Trash2 size={14} /></button>
              </div>
            </div>
          );
        })}
        {items.length === 0 && <div style={{ fontSize: 13, color: colors.textDim, padding: "6px 0" }}>Añade al menos un alimento.</div>}

        {items.length > 0 && (
          <div className="flex justify-between items-center mt-2 pt-2" style={{ borderTop: `1px solid ${colors.border}`, fontWeight: 600, fontSize: 13.5 }}>
            <span>Total</span><span>{round1(totals.kcal)} kcal</span>
          </div>
        )}

        {!showAddForm ? (
          <button onClick={() => setShowAddForm(true)} className="flex items-center gap-1" style={{ marginTop: 12, fontSize: 12.5, color: colors.accent }}>
            <Plus size={14} /> Añadir alimento
          </button>
        ) : (
          <AddFoodForm colors={colors} onAdd={addItem} onCancel={() => setShowAddForm(false)} />
        )}

        <div className="flex gap-2 mt-4">
          <button onClick={() => canSave && onSave(name.trim(), items)} disabled={!canSave} className="flex items-center justify-center gap-1"
            style={{ flex: 1, background: colors.accent, color: "#fff", padding: "9px 0", borderRadius: 12, fontSize: 13.5, fontWeight: 600, opacity: canSave ? 1 : 0.5 }}>
            <Check size={15} /> Guardar
          </button>
          <button onClick={onClose} style={{ flex: 1, background: colors.surfaceSoft, color: colors.text, padding: "9px 0", borderRadius: 12, fontSize: 13.5, fontWeight: 600 }}>Cancelar</button>
        </div>
        {!isNew && (
          <button onClick={onDelete} className="flex items-center justify-center gap-1" style={{ width: "100%", marginTop: 8, color: colors.danger, padding: "8px 0", fontSize: 12.5 }}>
            <Trash2 size={14} /> Eliminar esta favorita
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- Confirmación de importación (sobrescribe todos los datos) ----------
function ImportConfirmModal({ colors, filename, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }} onClick={busy ? undefined : onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: colors.surface, borderRadius: 20, padding: 20, width: "88%", maxWidth: 340 }}>
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle size={18} color={colors.danger} />
          <span style={{ fontWeight: 600, fontSize: 15 }}>Sobrescribir datos</span>
        </div>
        <div style={{ fontSize: 13, color: colors.textDim, lineHeight: 1.5, marginBottom: 16 }}>
          Vas a importar "{filename}". Todos tus datos actuales (comidas, objetivos, favoritas, hábitos, peso) se reemplazarán y no se podrán recuperar. ¿Continuar?
        </div>
        <div className="flex gap-2">
          <button onClick={onCancel} disabled={busy} style={{ flex: 1, background: colors.surfaceSoft, color: colors.text, padding: "9px 0", borderRadius: 12, fontSize: 13.5, fontWeight: 600 }}>Cancelar</button>
          <button
            onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}
            disabled={busy}
            style={{ flex: 1, background: colors.danger, color: "#fff", padding: "9px 0", borderRadius: 12, fontSize: 13.5, fontWeight: 600, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Sobrescribiendo…" : "Sobrescribir"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ================= PANTALLA: AJUSTES =================
function SettingsScreen({ colors, theme, setTheme, goals, setGoals, favorites, setFavorites, weights, setWeights, onExport, onImport }) {
  const fileInputRef = useRef(null);
  const [pendingImport, setPendingImport] = useState(null);
  const [importError, setImportError] = useState(null);
  const [importDone, setImportDone] = useState(false);

  function handleExportClick() {
    const payload = onExport();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nutrichat-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function handleImportClick() {
    setImportError(null);
    setImportDone(false);
    fileInputRef.current?.click();
  }

  async function handleFileSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !parsed.data) throw new Error("shape");
      setPendingImport({ parsed, filename: file.name });
    } catch (err) {
      setImportError("No se pudo leer el archivo. Asegúrate de que es un backup exportado desde esta app (.json).");
    }
  }

  async function confirmImport() {
    if (!pendingImport) return;
    try {
      await onImport(pendingImport.parsed);
      setPendingImport(null);
      setImportDone(true);
      setImportError(null);
    } catch (err) {
      console.error(err);
      setImportError(`No se pudo completar la importación. Detalle: ${err?.message || "error desconocido"}`);
      setPendingImport(null);
    }
  }
  const [localGoals, setLocalGoals] = useState(goals);
  const [newWeight, setNewWeight] = useState("");
  const [weightError, setWeightError] = useState(null);
  const [weightJustAdded, setWeightJustAdded] = useState(false);

  useEffect(() => { setLocalGoals(goals); }, [goals]);

  function saveGoals() {
    const g = {
      kcal: Number(localGoals.kcal) || 2000,
      protein: localGoals.protein ? Number(localGoals.protein) : null,
      fat: localGoals.fat ? Number(localGoals.fat) : null,
      carbs: localGoals.carbs ? Number(localGoals.carbs) : null
    };
    setGoals(g);
  }

  function addWeight() {
    setWeightError(null);
    const normalized = String(newWeight).trim().replace(",", ".");
    const kg = parseFloat(normalized);
    if (!Number.isFinite(kg) || kg <= 0) {
      setWeightError('Introduce un peso válido, por ejemplo "75.4" o "75,4".');
      return;
    }
    const updated = [...weights.filter((w) => w.date !== todayStr()), { date: todayStr(), kg: round1(kg) }].sort((a, b) => a.date.localeCompare(b.date));
    setWeights(updated);
    setNewWeight("");
    setWeightJustAdded(true);
    setTimeout(() => setWeightJustAdded(false), 2000);
  }

  function removeFavorite(id) { setFavorites((prev) => prev.filter((f) => f.id !== id)); }
  const [editingFavorite, setEditingFavorite] = useState(null);
  const [creatingFavorite, setCreatingFavorite] = useState(false);
  function saveFavorite(name, items) {
    if (editingFavorite) {
      setFavorites((prev) => prev.map((f) => (f.id === editingFavorite.id ? { ...f, name, items } : f)));
      setEditingFavorite(null);
    } else {
      setFavorites((prev) => [...prev, { id: uid(), name, items }]);
      setCreatingFavorite(false);
    }
  }

  const weightChartData = weights.slice(-30).map((w) => ({ date: w.date.slice(5), kg: w.kg }));

  return (
    <div className="overflow-y-auto px-4 py-5" style={{ height: "100%" }}>
      <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Ajustes</div>

      <Card colors={colors} style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>Objetivos nutricionales</div>
        {[
          ["kcal", "Calorías máximas diarias"],
          ["protein", "Proteína (g, opcional)"],
          ["fat", "Grasas (g, opcional)"],
          ["carbs", "Hidratos (g, opcional)"]
        ].map(([key, label]) => (
          <div key={key} className="flex items-center justify-between mb-2">
            <span style={{ fontSize: 13, color: colors.textDim }}>{label}</span>
            <input type="number" value={localGoals[key] || ""} onChange={(e) => setLocalGoals({ ...localGoals, [key]: e.target.value })}
              onBlur={key === "kcal" ? () => setLocalGoals((g) => rebalanceMacros(g)) : undefined}
              style={{ width: 90, textAlign: "right", padding: "6px 8px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.surfaceSoft, color: colors.text }} />
          </div>
        ))}
        {(() => {
          const diff = Math.round(macroKcal(localGoals) - (Number(localGoals.kcal) || 0));
          const hasMacros = localGoals.protein || localGoals.fat || localGoals.carbs;
          if (!hasMacros) return null;
          return Math.abs(diff) <= 4
            ? <div style={{ fontSize: 12, color: colors.accent, marginTop: 4 }}>Los macros cuadran con las calorías.</div>
            : <div className="flex items-center justify-between" style={{ fontSize: 12, color: colors.textDim, marginTop: 4, gap: 8 }}>
                <span>Los macros suman {Math.round(macroKcal(localGoals))} kcal ({diff > 0 ? "+" : ""}{diff} respecto al objetivo).</span>
                <button onClick={() => setLocalGoals((g) => rebalanceMacros(g))} style={{ background: colors.surfaceSoft, color: colors.accent, padding: "5px 10px", borderRadius: 999, fontWeight: 600, whiteSpace: "nowrap" }}>Cuadrar</button>
              </div>;
        })()}
        <button onClick={saveGoals} style={{ marginTop: 10, width: "100%", background: colors.accent, color: "#fff", padding: "9px 0", borderRadius: 12, fontSize: 13.5, fontWeight: 600 }}>Guardar objetivos</button>
      </Card>

      <Card colors={colors} style={{ marginBottom: 16 }}>
        <div className="flex items-center justify-between">
          <span style={{ fontWeight: 600, fontSize: 14 }}>Apariencia</span>
          <button onClick={() => setTheme(theme === "light" ? "dark" : "light")} className="flex items-center gap-2"
            style={{ background: colors.surfaceSoft, padding: "6px 12px", borderRadius: 999, fontSize: 12.5 }}>
            {theme === "light" ? <Moon size={14} /> : <Sun size={14} />} {theme === "light" ? "Oscuro" : "Claro"}
          </button>
        </div>
      </Card>

      <Card colors={colors} style={{ marginBottom: 16 }}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2"><Star size={15} color={colors.accent} /><span style={{ fontWeight: 600, fontSize: 14 }}>Comidas favoritas</span></div>
          <button onClick={() => setCreatingFavorite(true)} className="flex items-center gap-1" style={{ fontSize: 12, background: colors.surfaceSoft, padding: "5px 10px", borderRadius: 999, color: colors.accent, fontWeight: 600 }}>
            <Plus size={13} /> Nueva
          </button>
        </div>
        {favorites.length === 0 && <div style={{ fontSize: 13, color: colors.textDim }}>Aún no tienes favoritas. Créala manualmente o di "guarda esto como…" tras registrar una comida en el chat.</div>}
        {favorites.map((f) => (
          <button key={f.id} onClick={() => setEditingFavorite(f)} className="flex items-center justify-between w-full text-left" style={{ padding: "6px 0", borderTop: `1px solid ${colors.border}` }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>{f.name}</div>
              <div style={{ fontSize: 11.5, color: colors.textDim }}>{f.items.map((i) => i.name).join(", ")}</div>
            </div>
            <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
              <span onClick={(e) => { e.stopPropagation(); removeFavorite(f.id); }} style={{ color: colors.danger, padding: 4 }}><Trash2 size={14} /></span>
              <ChevronRight size={14} style={{ opacity: 0.5 }} />
            </div>
          </button>
        ))}
      </Card>

      {(creatingFavorite || editingFavorite) && (
        <FavoriteEditModal
          favorite={editingFavorite} colors={colors}
          onClose={() => { setEditingFavorite(null); setCreatingFavorite(false); }}
          onSave={saveFavorite}
          onDelete={() => { if (editingFavorite) removeFavorite(editingFavorite.id); setEditingFavorite(null); }}
        />
      )}
      <Card colors={colors}>
        <div className="flex items-center gap-2 mb-3"><Scale size={15} color={colors.accent} /><span style={{ fontWeight: 600, fontSize: 14 }}>Peso corporal</span></div>
        <div className="flex gap-2 mb-2">
          <input type="text" inputMode="decimal" placeholder="kg (ej. 75,4)" value={newWeight} onChange={(e) => setNewWeight(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addWeight(); }}
            style={{ flex: 1, padding: "8px 10px", borderRadius: 10, border: `1px solid ${colors.border}`, background: colors.surfaceSoft, color: colors.text }} />
          <button onClick={addWeight} style={{ background: colors.accent, color: "#fff", padding: "0 16px", borderRadius: 10 }}><Plus size={16} /></button>
        </div>
        {weightError && <div style={{ fontSize: 12, color: colors.danger, marginBottom: 8 }}>{weightError}</div>}
        {weightJustAdded && <div style={{ fontSize: 12, color: colors.accent, marginBottom: 8 }}>✓ Peso registrado{weights.length ? `: ${weights[weights.length - 1].kg} kg` : ""}</div>}
        {weights.length > 0 && (
          <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 10 }}>
            Último registro: <b style={{ color: colors.text }}>{weights[weights.length - 1].kg} kg</b> ({humanDate(weights[weights.length - 1].date).split(",")[0]})
          </div>
        )}
        {weightChartData.length > 1 && (
          <div style={{ width: "100%", height: 140 }}>
            <ResponsiveContainer>
              <LineChart data={weightChartData}>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: colors.textDim }} axisLine={false} tickLine={false} />
                <YAxis domain={["dataMin - 1", "dataMax + 1"]} tick={{ fontSize: 10, fill: colors.textDim }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="kg" stroke={colors.accent} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        {weightChartData.length <= 1 && <div style={{ fontSize: 12.5, color: colors.textDim }}>Registra al menos dos pesos para ver la evolución.</div>}
      </Card>

      <Card colors={colors} style={{ marginTop: 16 }}>
        <div className="flex items-center gap-2 mb-2"><Database size={15} color={colors.accent} /><span style={{ fontWeight: 600, fontSize: 14 }}>Datos</span></div>
        <p style={{ fontSize: 12.5, color: colors.textDim, marginBottom: 12, lineHeight: 1.5 }}>
          Guarda una copia de todo (comidas, objetivos, favoritas, hábitos, peso) o recupérala en cualquier momento, por ejemplo tras generar una nueva versión de la app.
        </p>
        <div className="flex flex-col gap-2">
          <button onClick={handleExportClick} className="flex items-center justify-center gap-2" style={{ width: "100%", background: colors.surfaceSoft, color: colors.text, padding: "9px 0", borderRadius: 12, fontSize: 13.5, fontWeight: 600 }}>
            <Download size={15} /> Exportar datos
          </button>
          <button onClick={handleImportClick} className="flex items-center justify-center gap-2" style={{ width: "100%", background: colors.surfaceSoft, color: colors.text, padding: "9px 0", borderRadius: 12, fontSize: 13.5, fontWeight: 600 }}>
            <Upload size={15} /> Importar datos
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={handleFileSelected} />
        <p style={{ fontSize: 11, color: colors.textDim, marginTop: 10 }}>Se descarga un archivo .json. Importarlo sobrescribe todos los datos actuales.</p>
        {importError && <div style={{ fontSize: 12, color: colors.danger, marginTop: 8 }}>{importError}</div>}
        {importDone && <div style={{ fontSize: 12, color: colors.accent, marginTop: 8 }}>✓ Datos importados correctamente.</div>}
      </Card>

      {pendingImport && (
        <ImportConfirmModal colors={colors} filename={pendingImport.filename} onCancel={() => setPendingImport(null)} onConfirm={confirmImport} />
      )}
    </div>
  );
}

// ---------- Diagnóstico de almacenamiento persistente ----------
function StorageDiagnostic({ colors }) {
  const [status, setStatus] = useState("checking");
  const [detail, setDetail] = useState("");
  const [previousMark, setPreviousMark] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("diagnostic-marker", false);
        if (res && res.value) { setPreviousMark(res.value); setStatus("found-previous"); }
        else { setStatus("no-previous"); }
      } catch (e) { setStatus("no-previous"); }
    })();
  }, []);

  async function runTest() {
    setStatus("testing");
    const stamp = new Date().toLocaleString("es-ES");
    try {
      const writeRes = await window.storage.set("diagnostic-marker", stamp, false);
      if (!writeRes) { setStatus("error"); setDetail("window.storage.set devolvió null/vacío — la escritura no se confirmó."); return; }
      const readBack = await window.storage.get("diagnostic-marker", false);
      if (readBack && readBack.value === stamp) {
        setStatus("ok"); setDetail(stamp); setPreviousMark(stamp);
      } else {
        setStatus("mismatch");
        setDetail(`Escribí "${stamp}" pero al releer llegó: ${JSON.stringify(readBack)}`);
      }
    } catch (e) {
      setStatus("error"); setDetail(e?.message || String(e));
    }
  }

  return (
    <Card colors={colors} style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Diagnóstico de almacenamiento</div>

      {status === "checking" && <div style={{ fontSize: 12.5, color: colors.textDim }}>Comprobando...</div>}

      {status === "found-previous" && (
        <div style={{ fontSize: 12.5, color: colors.accent, marginBottom: 8 }}>
          ✓ Encontrada una marca guardada en una sesión anterior: <b>{previousMark}</b>. Esto confirma que el almacenamiento SÍ está persistiendo entre sesiones.
        </div>
      )}
      {status === "no-previous" && (
        <div style={{ fontSize: 12.5, color: colors.textDim, marginBottom: 8 }}>
          No hay ninguna marca previa guardada (o es la primera vez que abres esta versión publicada). Pulsa el botón, cierra el navegador entero y vuelve a esta misma URL para comprobar si persiste.
        </div>
      )}

      <button onClick={runTest} style={{ fontSize: 12.5, background: colors.surfaceSoft, padding: "7px 14px", borderRadius: 999, fontWeight: 500 }}>
        Probar guardado ahora
      </button>

      {status === "ok" && <div style={{ fontSize: 12.5, color: colors.accent, marginTop: 8 }}>✓ Escrito y releído correctamente: {detail}</div>}
      {(status === "error" || status === "mismatch") && <div style={{ fontSize: 12.5, color: colors.danger, marginTop: 8 }}>✗ Fallo: {detail}</div>}

      <div style={{ fontSize: 11, color: colors.textDim, marginTop: 10, lineHeight: 1.5 }}>
        Cómo comprobar persistencia real: pulsa "Probar guardado ahora" → cierra el navegador ENTERO (no solo la pestaña) → abre de nuevo esta misma URL publicada → vuelve a Ajustes. Si arriba aparece "Encontrada una marca guardada" con la misma hora, el almacenamiento funciona. Si aparece "No hay ninguna marca previa", el almacenamiento no está persistiendo en esta URL.
      </div>
    </Card>
  );
}

// ================= APP RAÍZ =================
export default function NutriChatAI() {
  const [theme, setTheme] = useState("light");
  const [tab, setTab] = useState("chat");
  const [loaded, setLoaded] = useState(false);
  const [goals, setGoals] = useState({ kcal: 2000, protein: null, fat: null, carbs: null });
  const [meals, setMeals] = useState({}); // { 'YYYY-MM-DD': [meal,...] }
  const [favorites, setFavorites] = useState([]);
  const [habits, setHabits] = useState({});
  const [weights, setWeights] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);

  // Permite precargar el chat con texto desde un Atajo de iPhone (Siri > Dictado >
  // Abrir URL con ?log=<texto codificado>). Si el sandbox del artifact bloquea la
  // lectura de parámetros de URL (como bloquea el micrófono), esto simplemente no
  // hará nada — es una mejora opcional, no rompe el resto de la app si falla.
  const [quickLogText] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const text = params.get("log") || params.get("text") || "";
      if (text) window.history.replaceState({}, "", window.location.pathname);
      return text;
    } catch (e) { return ""; }
  });

  const colors = palette[theme];

  useEffect(() => {
    (async () => {
      const t = await loadJSON("theme", "light"); setTheme(t);
      const g = await loadJSON("goals", { kcal: 2000, protein: null, fat: null, carbs: null }); setGoals(g);
      const fav = await loadJSON("favorites", []); setFavorites(fav);
      const hab = await loadJSON("habits", {}); setHabits(hab);
      const w = await loadJSON("weights", []); setWeights(w);
      const chat = await loadJSON("chat-history", []); setChatMessages(chat);
      let keys = [];
      try { const r = await window.storage.list("meals-", false); keys = r?.keys || []; } catch (e) { keys = []; }
      const mealsObj = {};
      for (const k of keys) {
        const date = k.replace("meals-", "");
        mealsObj[date] = await loadJSON(k, []);
      }
      setMeals(mealsObj);
      setLoaded(true);
    })();
  }, []);

  useEffect(() => { if (loaded) saveJSON("theme", theme); }, [theme, loaded]);
  useEffect(() => { if (loaded) saveJSON("goals", goals); }, [goals, loaded]);
  useEffect(() => { if (loaded) saveJSON("favorites", favorites); }, [favorites, loaded]);
  useEffect(() => { if (loaded) saveJSON("habits", habits); }, [habits, loaded]);
  useEffect(() => { if (loaded) saveJSON("weights", weights); }, [weights, loaded]);
  useEffect(() => { if (loaded) saveJSON("chat-history", chatMessages.slice(-100)); }, [chatMessages, loaded]);

  // Índice de alimentos ya registrados antes, para autocompletar mientras se escribe
  // en el chat: nombre, última cantidad usada y sus macros por 100g. Se queda con el
  // uso más reciente de cada alimento (recorriendo las fechas en orden ascendente) y
  // cuenta cuántas veces se ha usado, para poder priorizar los más frecuentes.
  const foodIndex = useMemo(() => {
    const idx = new Map();
    const sortedDates = Object.keys(meals).sort();
    for (const date of sortedDates) {
      for (const meal of meals[date] || []) {
        for (const it of meal.items || []) {
          const key = normalizePhrase(it.name);
          if (!key) continue;
          const existing = idx.get(key);
          idx.set(key, {
            name: it.name,
            quantity_g: it.quantity_g,
            unit_label: it.unit_label || "",
            kcal_per_100g: it.kcal_per_100g,
            protein_per_100g: it.protein_per_100g,
            fat_per_100g: it.fat_per_100g,
            carbs_per_100g: it.carbs_per_100g,
            count: (existing?.count || 0) + 1
          });
        }
      }
    }
    return Array.from(idx.values());
  }, [meals]);

  function setMealsForDate(date, updater) {
    setMeals((prev) => {
      const current = prev[date] || [];
      const updated = typeof updater === "function" ? updater(current) : updater;
      saveJSON(`meals-${date}`, updated);
      return { ...prev, [date]: updated };
    });
  }

  function gatherExportPayload() {
    return {
      app: "NutriChatAI",
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      data: { theme, goals, favorites, habits, weights, chatMessages, meals }
    };
  }

  async function applyImportedData(parsed) {
    const d = parsed.data || {};
    const nextTheme = d.theme === "dark" ? "dark" : "light";
    const nextGoals = d.goals && typeof d.goals === "object" ? d.goals : { kcal: 2000, protein: null, fat: null, carbs: null };
    const nextFavorites = Array.isArray(d.favorites) ? d.favorites : [];
    const nextHabits = d.habits && typeof d.habits === "object" ? d.habits : {};
    const nextWeights = Array.isArray(d.weights) ? d.weights : [];
    const nextChat = Array.isArray(d.chatMessages) ? d.chatMessages : [];
    const nextMeals = d.meals && typeof d.meals === "object" ? d.meals : {};

    // Borra fechas de comidas que ya no están en el backup importado, para que sea
    // una sobrescritura real y no una mezcla con lo que hubiera antes.
    let existingKeys = [];
    try { const r = await window.storage.list("meals-", false); existingKeys = r?.keys || []; } catch (e) { existingKeys = []; }
    const newMealKeys = new Set(Object.keys(nextMeals).map((date) => `meals-${date}`));
    for (const k of existingKeys) {
      if (!newMealKeys.has(k)) { try { await window.storage.delete(k, false); } catch (e) { /* ignorar */ } }
    }

    await saveJSONStrict("theme", nextTheme);
    await saveJSONStrict("goals", nextGoals);
    await saveJSONStrict("favorites", nextFavorites);
    await saveJSONStrict("habits", nextHabits);
    await saveJSONStrict("weights", nextWeights);
    await saveJSONStrict("chat-history", nextChat);
    for (const [date, list] of Object.entries(nextMeals)) { await saveJSONStrict(`meals-${date}`, list); }

    setTheme(nextTheme);
    setGoals(nextGoals);
    setFavorites(nextFavorites);
    setHabits(nextHabits);
    setWeights(nextWeights);
    setChatMessages(nextChat);
    setMeals(nextMeals);
  }

  if (!loaded) {
    return <div style={{ height: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: colors.bg, color: colors.text }}>
      <Loader2 className="animate-spin" />
    </div>;
  }

  const tabs = [
    { id: "chat", label: "Chat", icon: MessageCircle },
    { id: "dashboard", label: "Hoy", icon: LayoutGrid },
    { id: "history", label: "Historial", icon: HistoryIcon },
    { id: "settings", label: "Ajustes", icon: SettingsIcon }
  ];

  return (
    <div style={{ height: "100dvh", maxWidth: 480, margin: "0 auto", background: colors.bg, color: colors.text, display: "flex", flexDirection: "column", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      <div style={{ padding: "14px 18px 10px", display: "flex", alignItems: "center", gap: 8, borderBottom: `1px solid ${colors.border}` }}>
        <ChefHat size={18} color={colors.accent} />
        <span style={{ fontWeight: 700, fontSize: 15 }}>NutriChat AI</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === "chat" && <ChatScreen colors={colors} goals={goals} favorites={favorites} setFavorites={setFavorites} habits={habits} setHabits={setHabits} meals={meals} setMealsForDate={setMealsForDate} chatMessages={chatMessages} setChatMessages={setChatMessages} initialInput={quickLogText} foodIndex={foodIndex} />}
        {tab === "dashboard" && <DashboardScreen colors={colors} goals={goals} meals={meals} />}
        {tab === "history" && <HistoryScreen colors={colors} meals={meals} goals={goals} setMealsForDate={setMealsForDate} />}
        {tab === "settings" && <SettingsScreen colors={colors} theme={theme} setTheme={setTheme} goals={goals} setGoals={setGoals} favorites={favorites} setFavorites={setFavorites} weights={weights} setWeights={setWeights} onExport={gatherExportPayload} onImport={applyImportedData} />}
      </div>
      <div style={{ display: "flex", borderTop: `1px solid ${colors.border}`, background: colors.surface }}>
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ flex: 1, padding: "9px 0 10px", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, color: active ? colors.accent : colors.textDim }}>
              <Icon size={19} strokeWidth={active ? 2.4 : 2} />
              <span style={{ fontSize: 10.5, fontWeight: active ? 600 : 400 }}>{t.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

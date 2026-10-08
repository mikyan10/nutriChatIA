# NutriChat — despliegue en Netlify

## Pasos
1. Sube esta carpeta a un repositorio de GitHub (o arrástrala a Netlify en "Add new site > Deploy manually", ejecutando antes `npm install && npm run build` y arrastrando la carpeta completa; para que la función funcione se recomienda el despliegue por Git o Netlify CLI).
2. En Netlify: **Add new site > Import an existing project** y elige el repo. Netlify lee `netlify.toml` (build `npm run build`, publica `dist`, funciones en `netlify/functions`).
3. **Site configuration > Environment variables**: crea `ANTHROPIC_API_KEY` con tu clave de https://console.anthropic.com (opcional: `CLAUDE_MODEL` para forzar el modelo).
4. Despliega de nuevo (Deploys > Trigger deploy).

## Local
`npm install` y `npx netlify dev` (con la variable en un `.env`) para probar con la función. `npm run dev` solo sirve la interfaz.

## Notas
- Los datos se guardan en el navegador (localStorage) de cada dispositivo: usa Ajustes > Exportar/Importar para copias de seguridad o pasar datos entre dispositivos.
- La clave nunca llega al navegador. Aun así, cualquiera con la URL puede gastar tu crédito: protege el sitio (Netlify Password Protection en planes de pago) y fija un límite de gasto en la consola de Anthropic.
- Atajo de iPhone: abre `https://TU-SITIO.netlify.app/?log=texto`.

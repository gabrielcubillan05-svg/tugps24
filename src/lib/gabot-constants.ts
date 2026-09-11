// Identidad del remitente virtual del chat interno "GaBot" — separado de gabot.ts para que
// conversations.ts (que necesita el nombre para mostrarlo) no tenga que importar gabot.ts
// (que sí importa de conversations.ts), evitando una dependencia circular entre ambos.
export const GABOT_ID = 'gabot-system';
export const GABOT_NAME = 'GaBot 🤖 (asistente)';

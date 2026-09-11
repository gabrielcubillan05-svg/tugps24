// Identidad del remitente virtual del chat interno "GPSITO" — separado de gabot.ts para que
// conversations.ts (que necesita el nombre para mostrarlo) no tenga que importar gabot.ts
// (que sí importa de conversations.ts), evitando una dependencia circular entre ambos.
// El id interno se mantiene como "gabot-*" en el código por simplicidad (no es visible para
// el usuario), aunque el nombre que ve el equipo es GPSITO.
export const GABOT_ID = 'gabot-system';
export const GABOT_NAME = 'GPSITO';

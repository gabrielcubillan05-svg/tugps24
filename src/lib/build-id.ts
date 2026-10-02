// Identificador del despliegue en curso. Las pestañas del panel se quedan abiertas horas o
// días (la central no la cierra nunca), así que un despliegue nuevo no les llega hasta que
// alguien recarga: el JS viejo sigue corriendo y las funciones nuevas, como la alarma de
// apagados, no aparecen. El layout lo imprime en el <body> y la campanita lo compara con
// /api/version en cada sondeo para recargar sola cuando cambia.
export const BUILD_ID: string = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || 'dev';

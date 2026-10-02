// Compresión de fotos en el navegador antes de subirlas: una foto de celular de 4 a 8 MB
// queda en unos 300 KB sin que se note en pantalla. Expone window.compressImageFile.
// Si algo falla (formato raro, navegador viejo) devuelve el archivo original para no
// bloquear el envío.
(function () {
  function compressImageFile(file, options) {
    const maxDim = (options && options.maxDim) || 1600;
    const quality = (options && options.quality) || 0.78;
    if (!file || !file.type || !file.type.startsWith('image/')) return Promise.resolve(file);
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = function () {
        try {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          canvas.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            // Si la compresión no ahorra nada (ya era pequeña), se manda la original.
            if (!blob || blob.size >= file.size) return resolve(file);
            resolve(new File([blob], (file.name || 'foto').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
          }, 'image/jpeg', quality);
        } catch {
          URL.revokeObjectURL(url);
          resolve(file);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }
  window.compressImageFile = compressImageFile;
})();

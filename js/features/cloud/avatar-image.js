export const AVATAR_MAX_BYTES = 500_000;
export const AVATAR_MAX_SOURCE_BYTES = 20_000_000;
export const AVATAR_MAX_DIMENSION = 1024;

export function fittedAvatarSize(width, height, maxDimension = AVATAR_MAX_DIMENSION) {
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(reader.result));
        reader.addEventListener("error", () => reject(new Error("No se pudo leer la imagen.")));
        reader.readAsDataURL(blob);
    });
}

function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("No se pudo optimizar la imagen.")), type, quality);
    });
}

async function decodeImage(file) {
    if (typeof createImageBitmap === "function") return createImageBitmap(file);
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        return image;
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function optimizeAvatarImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file?.type || "")) {
        throw new Error("Elige una imagen JPG, PNG o WebP.");
    }
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > AVATAR_MAX_SOURCE_BYTES) {
        throw new Error("La imagen original no puede superar los 20 MB.");
    }

    const image = await decodeImage(file);
    try {
        const sourceWidth = image.width;
        const sourceHeight = image.height;
        if (!sourceWidth || !sourceHeight) throw new Error("La imagen no tiene unas dimensiones válidas.");
        if (file.size <= AVATAR_MAX_BYTES && Math.max(sourceWidth, sourceHeight) <= AVATAR_MAX_DIMENSION) {
            return readAsDataUrl(file);
        }

        const initial = fittedAvatarSize(sourceWidth, sourceHeight);
        const qualities = [0.88, 0.78, 0.68, 0.58, 0.48, 0.4];
        let scale = 1;
        while (initial.width * scale >= 128 && initial.height * scale >= 128) {
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(initial.width * scale));
            canvas.height = Math.max(1, Math.round(initial.height * scale));
            const context = canvas.getContext("2d", { alpha: true });
            if (!context) throw new Error("El navegador no permite optimizar esta imagen.");
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            for (const quality of qualities) {
                const blob = await canvasBlob(canvas, "image/webp", quality);
                if (blob.size <= AVATAR_MAX_BYTES) return readAsDataUrl(blob);
            }
            scale *= 0.8;
        }
        throw new Error("No se pudo reducir la imagen por debajo de 500 KB.");
    } finally {
        image.close?.();
    }
}

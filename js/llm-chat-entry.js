import("./llm-chat.js?v=11")
    .then(({ initLlmChat }) => initLlmChat())
    .catch((error) => {
        console.error("No se pudo iniciar el asistente del viaje", error);
        const launcher = document.querySelector("#llmChatLauncher");
        if (launcher) launcher.title = `No se pudo iniciar el asistente: ${error.message}`;
    });

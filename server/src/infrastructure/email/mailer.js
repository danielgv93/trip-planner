export function createDevelopmentMailer({ logger = console } = {}) {
    return {
        async sendLoginLink({ email, url }) {
            logger.info(JSON.stringify({ event: "development_login_link", emailHint: email.replace(/(^.).*(@.*$)/, "$1…$2"), url }));
        },
    };
}

export function createMailer(config, adapters = {}) {
    if (config.mailTransport === "development") {
        if (config.production) throw new Error("El transporte de desarrollo está deshabilitado en producción");
        return createDevelopmentMailer(adapters);
    }
    const adapter = adapters[config.mailTransport];
    if (!adapter) throw new Error(`Transporte de correo no configurado: ${config.mailTransport}`);
    return adapter;
}

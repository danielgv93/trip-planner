export class ApiError extends Error {
    constructor(status, code, message = code, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

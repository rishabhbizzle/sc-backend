'use strict';

// Thrown for invalid client input; server.js maps it to a 400 with the message.
class BadRequestError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BadRequestError';
    }
}

module.exports = { BadRequestError };

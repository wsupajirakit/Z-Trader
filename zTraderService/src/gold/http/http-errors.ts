import { BadRequestException, HttpException, InternalServerErrorException, Logger } from '@nestjs/common';
import { errorMessage, errorStack } from '../../common/utils/errors';
import { DomainError } from '../domain/domain-error';

export const INTERNAL_ERROR_MESSAGE = 'internal error — see the service log';

/**
 * What an HTTP caller may see of an error thrown by a gold service:
 * - an HttpException passes through unchanged (status and message were chosen on purpose)
 * - a DomainError (the caller broke a rule) becomes a 400 with its message
 * - anything else (TypeError, Mongo, broker, timeouts) is logged with its stack and becomes a generic
 *   500, so internals such as paths or driver messages never reach the response
 */
export function toHttpError(e: unknown, logger: Logger, context: string): HttpException {
    if (e instanceof HttpException) return e;
    if (e instanceof DomainError) return new BadRequestException(e.message);
    logger.error(`${context}: ${errorMessage(e)}`, errorStack(e));
    return new InternalServerErrorException(INTERNAL_ERROR_MESSAGE);
}

import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { ScanMethod } from '../../types/scanner.types';
import { AppError, ErrorCode } from '../../utils/app-error.util';

const targetSchema = z
  .string({ required_error: 'target is required' })
  .min(1, 'target cannot be empty')
  .max(253, 'target exceeds maximum length')
  .regex(
    /^(?:\d{1,3}\.){3}\d{1,3}$|^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
    'target must be a valid IPv4 address or hostname',
  );

const methodSchema = z.nativeEnum(ScanMethod, {
  errorMap: () => ({
    message: `method must be one of: ${Object.values(ScanMethod).join(', ')}`,
  }),
});

const credentialsSchema = z.object({
  username: z.string({ required_error: 'credentials.username is required' }).min(1, 'username cannot be empty'),
  password: z.string({ required_error: 'credentials.password is required' }).min(1, 'password cannot be empty'),
  domain:   z.string().optional(),
});

export const pingSchema = z.object({
  target: targetSchema,
});

export const testConnectionSchema = z.object({
  target:      targetSchema,
  method:      methodSchema,
  credentials: credentialsSchema,
});

export const hardwareSchema = z.object({
  target:      targetSchema,
  method:      methodSchema,
  credentials: credentialsSchema,
});

export const softwareSchema = z.object({
  target:      targetSchema,
  method:      methodSchema,
  credentials: credentialsSchema,
});

export const fullScanSchema = z.object({
  target:          targetSchema,
  method:          methodSchema,
  credentials:     credentialsSchema,
  skipPing:        z.boolean().default(false),
  skipSoftware:    z.boolean().default(false),
  continueOnError: z.boolean().default(true),
});

export type PingPayload           = z.infer<typeof pingSchema>;
export type TestConnectionPayload = z.infer<typeof testConnectionSchema>;
export type HardwarePayload       = z.infer<typeof hardwareSchema>;
export type SoftwarePayload       = z.infer<typeof softwareSchema>;
export type FullScanPayload       = z.infer<typeof fullScanSchema>;

export function validate<T>(schema: z.ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Request validation failed', {
        issues: result.error.flatten(),
      });
    }
    req.body = result.data;
    next();
  };
}

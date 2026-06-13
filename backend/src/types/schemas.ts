import { z } from 'zod';

export const SendOTPSchema = z.object({
  phoneNumber: z.string().min(7).max(15),
  countryCode: z.string().min(1).max(4).default('91'),
});

export const VerifyOTPSchema = z.object({
  phoneNumber:       z.string().min(7).max(15),
  countryCode:       z.string().min(1).max(4),
  otp:               z.string().length(6),
  deviceFingerprint: z.string().min(10),
});

export const EntityTypeSchema = z.enum([
  'biochar','agroforestry','soil_carbon','crop_residue',
  'solar_energy','ev_fleet','building','shipping','aviation','city','individual',
]);

export const LocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const CreateProjectSchema = z.object({
  entityType: EntityTypeSchema,
  name:       z.string().min(3).max(255),
  location:   LocationSchema,
  areaHa:     z.number().positive().optional(),
  metadata:   z.record(z.string(), z.unknown()),
});

export const CreateListingSchema = z.object({
  creditId:     z.string().uuid(),
  quantity:     z.number().positive(),
  unitPriceInr: z.number().positive(),
});

export const CreatePaymentSchema = z.object({
  listingId: z.string().uuid(),
  quantity:  z.number().positive(),
});

export const RetireCreditsSchema = z.object({
  creditId:         z.string().uuid(),
  quantity:         z.number().positive(),
  organisationName: z.string().optional(),
  esgReference:     z.string().optional(),
});

export type SendOTPInput       = z.infer<typeof SendOTPSchema>;
export type VerifyOTPInput     = z.infer<typeof VerifyOTPSchema>;
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
export type CreateListingInput = z.infer<typeof CreateListingSchema>;
export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
export type RetireCreditsInput = z.infer<typeof RetireCreditsSchema>;

import type { DomainEvent } from './outbox.ts'
import type { Event } from './event.ts'

export const VENDOR_CATEGORIES = [
  'buffet','photo','video','decoration','dj','band','cake','sweets','venue','transport','celebrant','security','other',
] as const
export type VendorCategory = (typeof VENDOR_CATEGORIES)[number]

export const VENDOR_CONFIRMATION_STATUSES = ['pending','requested','confirmed','declined','cancelled'] as const
export type VendorConfirmationStatus = (typeof VENDOR_CONFIRMATION_STATUSES)[number]

export const VENDOR_CONTRACT_STATUSES = ['not_applicable','pending','signed'] as const
export type VendorContractStatus = (typeof VENDOR_CONTRACT_STATUSES)[number]

export const VENDOR_PAYMENT_STATUSES = ['not_applicable','pending','partial','paid','overdue'] as const
export type VendorPaymentStatus = (typeof VENDOR_PAYMENT_STATUSES)[number]

export interface Vendor {
  id: string
  organizationId: string
  name: string
  category: VendorCategory
  contactName: string | null
  phone: string | null
  email: string | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
}

export interface EventVendor {
  id: string
  organizationId: string
  eventId: string
  vendorId: string
  vendorName: string
  category: VendorCategory
  contactName: string | null
  phone: string | null
  email: string | null
  confirmationStatus: VendorConfirmationStatus
  contractStatus: VendorContractStatus
  paymentStatus: VendorPaymentStatus
  arrivalAt: Date | null
  departureAt: Date | null
  teamSize: number | null
  confirmationRequestedAt: Date | null
  confirmationDeadlineAt: Date | null
  confirmedAt: Date | null
  declinedAt: Date | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateVendorInput {
  organizationId: string
  name: string
  category: VendorCategory
  contactName?: string | null
  phone?: string | null
  email?: string | null
  notes?: string | null
}

export interface AttachVendorToEventInput {
  organizationId: string
  eventId: string
  vendorId: string
  contactName?: string | null
  phone?: string | null
  email?: string | null
  arrivalAt?: Date | null
  departureAt?: Date | null
  teamSize?: number | null
  contractStatus?: VendorContractStatus
  paymentStatus?: VendorPaymentStatus
  notes?: string | null
}

export interface UpdateEventVendorInput {
  organizationId: string
  eventId: string
  eventVendorId: string
  contactName?: string | null
  phone?: string | null
  email?: string | null
  arrivalAt?: Date | null
  departureAt?: Date | null
  teamSize?: number | null
  contractStatus?: VendorContractStatus
  paymentStatus?: VendorPaymentStatus
  notes?: string | null
}

export interface RequestVendorConfirmationInput {
  organizationId: string
  eventId: string
  eventVendorId: string
  deadlineAt?: Date | null
}

export interface ConfirmVendorInput {
  organizationId: string
  eventId: string
  eventVendorId: string
  arrivalAt?: Date | null
  departureAt?: Date | null
  teamSize?: number | null
  notes?: string | null
}

export interface DeclineVendorInput {
  organizationId: string
  eventId: string
  eventVendorId: string
  notes?: string | null
}

export interface VendorStore {
  createVendor(vendor: Vendor): Promise<void>
  findVendorById(organizationId: string, vendorId: string): Promise<Vendor | null>
  listVendors(organizationId: string): Promise<Vendor[]>
  findEventById(organizationId: string, eventId: string): Promise<Event | null>
  findEventVendorById(organizationId: string, eventId: string, eventVendorId: string): Promise<EventVendor | null>
  findEventVendorByVendorId(organizationId: string, eventId: string, vendorId: string): Promise<EventVendor | null>
  listEventVendors(organizationId: string, eventId: string): Promise<EventVendor[]>
  createEventVendorWithOutbox(eventVendor: EventVendor, domainEvent: DomainEvent): Promise<void>
  updateEventVendorWithOutbox(eventVendor: EventVendor, domainEvent: DomainEvent): Promise<void>
}

export class VendorValidationError extends Error {
  readonly code = 'VENDOR_VALIDATION_ERROR'
  constructor(message: string) { super(message); this.name = 'VendorValidationError' }
}
export class VendorNotFoundError extends Error {
  readonly code = 'VENDOR_NOT_FOUND'
  constructor(message = 'Vendor not found') { super(message); this.name = 'VendorNotFoundError' }
}
export class EventVendorNotFoundError extends Error {
  readonly code = 'EVENT_VENDOR_NOT_FOUND'
  constructor(message = 'Event vendor not found') { super(message); this.name = 'EventVendorNotFoundError' }
}
export class DuplicateEventVendorError extends Error {
  readonly code = 'EVENT_VENDOR_ALREADY_ATTACHED'
  constructor(message = 'Vendor is already attached to this event') { super(message); this.name = 'DuplicateEventVendorError' }
}

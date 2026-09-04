export interface PublicEvent {
  id: string;
  name: string;
  date: number;
  totalSeats: number;
  pricePerSeat: number;
  coverImageUrl: string | null;
}

export interface EventData {
  id: string;
  name: string;
  description: string | null;
  date: number;
  totalSeats: number;
  pricePerSeat: number;
  coverImageUrl: string | null;
  organisationId: string;
}

export interface OrgEvent {
  id: string;
  name: string;
  date: number;
  totalSeats: number;
  pricePerSeat: number;
  coverImageUrl: string | null;
}

export interface AttendeeRow {
  id: string;
  seatCount: number;
  attendeeName: string;
  attendeeEmail: string;
}

export interface Booking {
  id: string;
  seatCount: number;
  eventId: string;
  eventName: string;
  eventDate: number;
  eventCoverImageUrl: string | null;
}

export interface ApiKeyInfo {
  keyPrefix: string;
  createdAt: number;
}

export interface SubscriptionData {
  subscriptionStatus: string;
  hasStripeCustomer: boolean;
}

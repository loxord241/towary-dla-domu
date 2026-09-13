'use client';

/* eslint-disable react-hooks/immutability -- the *Seq/debounce refs below
   are owned by CheckoutForm (created with useRef there) and passed down
   explicitly so delivery state stays in the orchestrator; the handler code
   is moved verbatim from the pre-split monolith, where the same mutations
   were made on locally-created refs. */

import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  searchUkrposhtaSettlementsApi,
  type UpUaOffice,
  type UpUaSettlement,
} from '../delivery-apis';
import { inputClass } from './form-styles';

interface UkrposhtaDeliveryProps {
  upSettlement: UpUaSettlement | null;
  upSettlementQuery: string;
  upSettlementResults: UpUaSettlement[];
  upSettlementOpen: boolean;
  upSettlementLoading: boolean;
  upOffices: UpUaOffice[];
  upOfficesLoading: boolean;
  upOffice: UpUaOffice | null;
  setUpSettlement: Dispatch<SetStateAction<UpUaSettlement | null>>;
  setUpSettlementQuery: (value: string) => void;
  setUpSettlementResults: Dispatch<SetStateAction<UpUaSettlement[]>>;
  setUpSettlementOpen: (value: boolean) => void;
  setUpSettlementLoading: (value: boolean) => void;
  setUpOffices: Dispatch<SetStateAction<UpUaOffice[]>>;
  setUpOfficesLoading: (value: boolean) => void;
  setUpOffice: Dispatch<SetStateAction<UpUaOffice | null>>;
  setDeliveryError: (value: string | null) => void;
  loadUkrposhtaOffices: (cityId: number) => void;
  upSettlementDebounceRef: RefObject<ReturnType<typeof setTimeout> | null>;
  upSettlementRequestSeq: RefObject<number>;
}

// Ukrposhta — Відділення: city autocomplete + office select
// against the open Address Classifier proxy routes.
// (Moved verbatim from CheckoutForm.tsx during the 2026-09-13 split.)
export default function UkrposhtaDelivery({
  upSettlement,
  upSettlementQuery,
  upSettlementResults,
  upSettlementOpen,
  upSettlementLoading,
  upOffices,
  upOfficesLoading,
  upOffice,
  setUpSettlement,
  setUpSettlementQuery,
  setUpSettlementResults,
  setUpSettlementOpen,
  setUpSettlementLoading,
  setUpOffices,
  setUpOfficesLoading,
  setUpOffice,
  setDeliveryError,
  loadUkrposhtaOffices,
  upSettlementDebounceRef,
  upSettlementRequestSeq,
}: UkrposhtaDeliveryProps) {
  return (
    <>
      <div className="relative mb-4">
        <label htmlFor="co-up-settlement" className="label">
          Населений пункт *
        </label>
        <input
          id="co-up-settlement"
          type="text"
          autoComplete="off"
          maxLength={100}
          placeholder="Почніть вводити назву міста…"
          value={
            upSettlement && upSettlementQuery === upSettlement.name
              ? upSettlement.name
              : upSettlementQuery
          }
          onChange={(e) => {
            const q = e.target.value;
            setUpSettlementQuery(q);
            setUpSettlement(null);
            setUpOffice(null);
            setUpOffices([]);
            setUpOfficesLoading(false);
            setUpSettlementOpen(true);
            if (upSettlementDebounceRef.current) clearTimeout(upSettlementDebounceRef.current);
            if (q.trim().length >= 2) {
              setUpSettlementLoading(true);
              const seq = ++upSettlementRequestSeq.current;
              upSettlementDebounceRef.current = setTimeout(() => {
                searchUkrposhtaSettlementsApi(
                  q.trim(),
                  (found) => {
                    if (seq !== upSettlementRequestSeq.current) return; // stale response
                    setUpSettlementResults(found);
                    setUpSettlementOpen(true);
                    setUpSettlementLoading(false);
                  },
                  () => {
                    if (seq !== upSettlementRequestSeq.current) return; // stale response
                    setUpSettlementResults([]);
                    setUpSettlementLoading(false);
                  }
                );
              }, 300);
            } else {
              // Query invalidated (too short): bump the sequence so
              // any in-flight response is dropped, reset the list.
              upSettlementRequestSeq.current += 1;
              setUpSettlementLoading(false);
              setUpSettlementResults([]);
            }
          }}
          className={inputClass}
        />
        {upSettlementOpen && !upSettlement && upSettlementQuery.trim().length >= 2 && (
          upSettlementLoading ? (
            <p className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500 shadow-lg" role="status">
              Шукаємо…
            </p>
          ) : upSettlementResults.length > 0 ? (
            <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
              {upSettlementResults.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50"
                    onClick={() => {
                      // Selection is final: drop any in-flight
                      // search response so it can't re-open the
                      // dropdown, and drop any in-flight office
                      // list for the previous city.
                      upSettlementRequestSeq.current += 1;
                      if (upSettlementDebounceRef.current) clearTimeout(upSettlementDebounceRef.current);
                      setUpSettlement(s);
                      setUpSettlementQuery(s.name);
                      setUpSettlementOpen(false);
                      setUpSettlementResults([]);
                      setUpSettlementLoading(false);
                      // The office belongs to the chosen city:
                      // keep a previously picked office of the old
                      // city from riding along in the order.
                      setUpOffice(null);
                      loadUkrposhtaOffices(s.id);
                    }}
                  >
                    <span className="block">{s.name}</span>
                    {(s.regionName || s.districtName) && (
                      <span className="block text-xs text-gray-500">
                        {[s.regionName, s.districtName].filter(Boolean).join(', ')}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500 shadow-lg">
              Нічого не знайдено — спробуйте іншу назву
            </p>
          )
        )}
      </div>

      <div className="mb-4">
        <label htmlFor="co-up-office" className="label">
          Відділення *
        </label>
        {upSettlement ? (
          upOfficesLoading ? (
            <p className="text-sm text-gray-500" role="status">
              Завантажуємо варіанти…
            </p>
          ) : upOffices.length > 0 ? (
            <select
              id="co-up-office"
              value={upOffice ? String(upOffice.id) : ''}
              onChange={(e) => {
                const o = upOffices.find(
                  (x) => String(x.id) === e.target.value
                );
                setUpOffice(o ?? null);
                setDeliveryError(null);
              }}
              className={inputClass}
            >
              <option value="">— оберіть відділення —</option>
              {upOffices.map((o) => (
                <option key={o.id} value={String(o.id)}>
                  {[o.shortName ?? o.longName, [o.postIndex, o.address].filter(Boolean).join(', ')]
                    .filter(Boolean)
                    .join(', ')}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm text-gray-500">
              Немає доступних відділень у цьому місті
            </p>
          )
        ) : (
          <p className="text-sm text-gray-500">спочатку оберіть населений пункт</p>
        )}
      </div>
    </>
  );
}

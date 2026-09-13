'use client';

/* eslint-disable react-hooks/immutability -- the *Seq/debounce refs below
   are owned by CheckoutForm (created with useRef there) and passed down
   explicitly so delivery state stays in the orchestrator; the handler code
   is moved verbatim from the pre-split monolith, where the same mutations
   were made on locally-created refs. */

import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  fetchDivisionsApi,
  isNpWarehouseType,
  searchSettlementsApi,
  searchStreetsApi,
  type DeliveryType,
  type NpDivision,
  type NpSettlement,
  type NpStreet,
} from '../delivery-apis';
import { inputClass } from './form-styles';

// The live /divisions divisionCategory value for parcel lockers is
// "Postomat" (live-verified 2026-08-28); branches are PostBranch /
// CargoBranch. Match case-insensitively as a safety net.
const isLockerCategory = (category: string | null): boolean =>
  typeof category === 'string' && /postomat/i.test(category);

interface NovaPostDeliveryProps {
  deliveryType: DeliveryType | '';
  settlement: NpSettlement | null;
  settlementQuery: string;
  settlementResults: NpSettlement[];
  settlementOpen: boolean;
  settlementLoading: boolean;
  divisions: NpDivision[];
  divisionsLoading: boolean;
  division: NpDivision | null;
  street: NpStreet | null;
  streetQuery: string;
  streetResults: NpStreet[];
  streetOpen: boolean;
  building: string;
  flat: string;
  setSettlement: Dispatch<SetStateAction<NpSettlement | null>>;
  setSettlementQuery: (value: string) => void;
  setSettlementResults: Dispatch<SetStateAction<NpSettlement[]>>;
  setSettlementOpen: (value: boolean) => void;
  setSettlementLoading: (value: boolean) => void;
  setDivision: Dispatch<SetStateAction<NpDivision | null>>;
  setDivisions: Dispatch<SetStateAction<NpDivision[]>>;
  setDivisionsLoading: (value: boolean) => void;
  setStreet: Dispatch<SetStateAction<NpStreet | null>>;
  setStreetQuery: Dispatch<SetStateAction<string>>;
  setStreetResults: Dispatch<SetStateAction<NpStreet[]>>;
  setStreetOpen: (value: boolean) => void;
  setBuilding: (value: string) => void;
  setFlat: (value: string) => void;
  setDeliveryError: (value: string | null) => void;
  settlementDebounceRef: RefObject<ReturnType<typeof setTimeout> | null>;
  settlementRequestSeq: RefObject<number>;
  divisionsRequestSeq: RefObject<number>;
  streetDebounceRef: RefObject<ReturnType<typeof setTimeout> | null>;
  streetRequestSeq: RefObject<number>;
}

// Nova Post delivery fields — settlement autocomplete, branch/parcel-locker
// select and courier address (moved verbatim from CheckoutForm.tsx during
// the 2026-09-13 mechanical split). Rendered by CheckoutForm only when an
// NP service type is chosen (not pickup, not Ukrposhta).
export default function NovaPostDelivery({
  deliveryType,
  settlement,
  settlementQuery,
  settlementResults,
  settlementOpen,
  settlementLoading,
  divisions,
  divisionsLoading,
  division,
  street,
  streetQuery,
  streetResults,
  streetOpen,
  building,
  flat,
  setSettlement,
  setSettlementQuery,
  setSettlementResults,
  setSettlementOpen,
  setSettlementLoading,
  setDivision,
  setDivisions,
  setDivisionsLoading,
  setStreet,
  setStreetQuery,
  setStreetResults,
  setStreetOpen,
  setBuilding,
  setFlat,
  setDeliveryError,
  settlementDebounceRef,
  settlementRequestSeq,
  divisionsRequestSeq,
  streetDebounceRef,
  streetRequestSeq,
}: NovaPostDeliveryProps) {
  const divisionsForType =
    deliveryType === 'nova_poshta_locker'
      ? divisions.filter((d) => isLockerCategory(d.category))
      : deliveryType === 'nova_poshta_warehouse'
        ? divisions.filter((d) => !isLockerCategory(d.category))
        : [];

  return (
    <>
      {/* Settlement — NP dictionary id is the identifier; the text is display only.
          Rendered only once a Nova Post service type is chosen; the Ukrposhta
          branch has its own city field. Pickup has no dictionaries at all. */}
      <div className="relative mb-4">
        <label htmlFor="co-settlement" className="label">
          Населений пункт *
        </label>
        <input
          id="co-settlement"
          type="text"
          autoComplete="off"
          maxLength={100}
          placeholder="Почніть вводити назву міста…"
          value={
            settlement && settlementQuery === settlement.name
              ? settlement.name
              : settlementQuery
          }
          onChange={(e) => {
            const q = e.target.value;
            setSettlementQuery(q);
            setSettlement(null);
            setDivision(null);
            setDivisions([]);
            setDivisionsLoading(false);
            setStreet(null);
            setStreetQuery('');
            setStreetResults([]);
            setSettlementOpen(true);
            if (settlementDebounceRef.current) clearTimeout(settlementDebounceRef.current);
            if (q.trim().length >= 2) {
              setSettlementLoading(true);
              const seq = ++settlementRequestSeq.current;
              settlementDebounceRef.current = setTimeout(() => {
                searchSettlementsApi(
                  q.trim(),
                  (found) => {
                    if (seq !== settlementRequestSeq.current) return; // stale response
                    setSettlementResults(found);
                    setSettlementOpen(true);
                    setSettlementLoading(false);
                  },
                  () => {
                    if (seq !== settlementRequestSeq.current) return; // stale response
                    setSettlementResults([]);
                    setSettlementLoading(false);
                  }
                );
              }, 300);
            } else {
              // Query invalidated (too short): bump the sequence so any
              // in-flight response is dropped, and reset list state.
              settlementRequestSeq.current += 1;
              setSettlementLoading(false);
              setSettlementResults([]);
            }
          }}
          className={inputClass}
        />
        {/* Autocomplete states: results, loading, empty — free text is
            never treated as a chosen settlement (id comes only from a
            list click, so the submit gate stays strict). */}
        {settlementOpen && !settlement && settlementQuery.trim().length >= 2 && (
          settlementLoading ? (
            <p className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500 shadow-lg" role="status">
              Шукаємо…
            </p>
          ) : settlementResults.length > 0 ? (
            <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
              {settlementResults.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50"
                    onClick={() => {
                      // Selection is final: drop any in-flight search
                      // response so it can't re-open the dropdown.
                      settlementRequestSeq.current += 1;
                      if (settlementDebounceRef.current) clearTimeout(settlementDebounceRef.current);
                      setSettlement(s);
                      setSettlementQuery(s.name);
                      setSettlementOpen(false);
                      setSettlementResults([]);
                      setSettlementLoading(false);
                      // Division/street belong to the chosen settlement:
                      // keep a previously picked division/street from the
                      // old settlement from riding along in the order.
                      setDivision(null);
                      setStreet(null);
                      setStreetQuery('');
                      setStreetResults([]);
                      setStreetOpen(false);
                      setBuilding('');
                      setFlat('');
                      divisionsRequestSeq.current += 1;
                      streetRequestSeq.current += 1;
                      if (deliveryType && isNpWarehouseType(deliveryType)) {
                        const seq = divisionsRequestSeq.current;
                        setDivisionsLoading(true);
                        fetchDivisionsApi(
                          s.id,
                          (items) => {
                            if (seq !== divisionsRequestSeq.current) return; // stale response
                            setDivisions(items);
                            setDivisionsLoading(false);
                          },
                          () => {
                            if (seq !== divisionsRequestSeq.current) return;
                            setDivisions([]);
                            setDivisionsLoading(false);
                          }
                        );
                      }
                    }}
                  >
                    <span className="block">{s.name}</span>
                    {(s.regionName || s.regionParentName) && (
                      <span className="block text-xs text-gray-500">
                        {[s.regionParentName, s.regionName].filter(Boolean).join(', ')}
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

      {/* Branch / parcel locker */}
      {(deliveryType === 'nova_poshta_warehouse' ||
        deliveryType === 'nova_poshta_locker') && (
        <div className="mb-4">
          <label htmlFor="co-division" className="label">
            {deliveryType === 'nova_poshta_locker' ? 'Поштомат *' : 'Відділення *'}
          </label>
          {settlement ? (
            divisionsLoading ? (
              <p className="text-sm text-gray-500" role="status">
                Завантажуємо варіанти…
              </p>
            ) : divisionsForType.length > 0 ? (
              <select
                id="co-division"
                value={division ? String(division.id) : ''}
                onChange={(e) => {
                  const d = divisionsForType.find(
                    (x) => String(x.id) === e.target.value
                  );
                  setDivision(d ?? null);
                  setDeliveryError(null);
                }}
                className={inputClass}
              >
                <option value="">
                  — оберіть {deliveryType === 'nova_poshta_locker' ? 'поштомат' : 'відділення'} —
                </option>
                {divisionsForType.map((d) => (
                  <option key={d.id} value={String(d.id)}>
                    {d.name}
                    {d.address ? ` (${d.address})` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-sm text-gray-500">
                Немає доступних варіантів у цьому місті
              </p>
            )
          ) : (
            <p className="text-sm text-gray-500">спочатку оберіть населений пункт</p>
          )}
        </div>
      )}

      {/* Courier address */}
      {deliveryType === 'nova_poshta_courier' && (
        <div className="space-y-4">
          <div className="relative">
            <label htmlFor="co-street" className="label">
              Вулиця *
            </label>
            <input
              id="co-street"
              type="text"
              autoComplete="off"
              maxLength={100}
              disabled={!settlement}
              placeholder={
                settlement ? 'Почніть вводити назву вулиці…' : 'спочатку оберіть населений пункт'
              }
              value={street && streetQuery === street.name ? street.name : streetQuery}
              onChange={(e) => {
                const q = e.target.value;
                setStreetQuery(q);
                setStreet(null);
                setStreetOpen(true);
                if (streetDebounceRef.current) clearTimeout(streetDebounceRef.current);
                if (settlement && q.trim().length >= 2) {
                  const seq = ++streetRequestSeq.current;
                  streetDebounceRef.current = setTimeout(() => {
                    if (seq !== streetRequestSeq.current) return; // superseded while debouncing
                    searchStreetsApi(
                      settlement.id,
                      q.trim(),
                      (found) => {
                        if (seq !== streetRequestSeq.current) return; // stale response
                        setStreetResults(found);
                        setStreetOpen(true);
                      },
                      () => {
                        if (seq !== streetRequestSeq.current) return;
                        setStreetResults([]);
                      }
                    );
                  }, 300);
                } else {
                  streetRequestSeq.current += 1;
                  setStreetResults([]);
                }
              }}
              className={inputClass}
            />
            {streetOpen && streetResults.length > 0 && !street && (
              <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
                {streetResults.map((st) => (
                  <li key={st.id}>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50"
                      onClick={() => {
                        setStreet(st);
                        setStreetQuery(st.name);
                        setStreetOpen(false);
                        setStreetResults([]);
                        setDeliveryError(null);
                      }}
                    >
                      {st.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="co-building" className="label">
                Будинок *
              </label>
              <input
                id="co-building"
                type="text"
                maxLength={100}
                value={building}
                onChange={(e) => setBuilding(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="co-flat" className="label">
                Квартира
              </label>
              <input
                id="co-flat"
                type="text"
                maxLength={10}
                value={flat}
                onChange={(e) => setFlat(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

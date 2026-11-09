import { useCallback, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useParams } from "react-router";
import { useApi } from "../../api/ApiContext";
import { useMarket } from "../../api/MarketContext";
import type {
  CustomerBooking,
  JobSize,
  PaymentStep,
  Postcode,
  Service,
  Slot,
} from "../../api/types";
import { useResource } from "../../api/useResource";
import { ErrorText } from "../../components/ErrorText";
import { Icon } from "../../components/Icon";
import { ResourceState } from "../../components/ResourceState";
import {
  dateTime,
  dayKey,
  dayParts,
  euro,
  sizePrice,
  time,
} from "../../lib/format";
import { useAction } from "../../lib/useAction";
import { CardPayment } from "../../payments/CardPayment";
import { AppHeader } from "../../shells/Shells";

const SIZES: JobSize[] = ["S", "M", "L"];

interface Details {
  address: string;
  postcode: string;
  size: JobSize;
  notes: string;
}

function DetailsStep({
  service,
  isGarden,
  details,
  onChange,
  onNext,
}: {
  service: Service;
  isGarden: boolean;
  details: Details;
  onChange: (details: Details) => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const loadPostcodes = useCallback(
    () => api.get<{ postcodes: Postcode[] }>("/postcodes"),
    [api],
  );
  const postcodes = useResource(loadPostcodes);
  const sizeGroup = isGarden ? "garden" : "job";

  function submit(event: FormEvent) {
    event.preventDefault();
    onNext();
  }

  return (
    <form onSubmit={submit}>
      <div className="body">
        <div className="field">
          <label htmlFor="address">{t("book.address")}</label>
          <input
            id="address"
            autoComplete="street-address"
            required
            minLength={3}
            maxLength={200}
            value={details.address}
            onChange={(event) =>
              onChange({ ...details, address: event.target.value })
            }
          />
        </div>
        <ResourceState state={postcodes.state} reload={postcodes.reload}>
          {({ postcodes: list }) => (
            <div className="field">
              <label htmlFor="postcode">{t("book.postcode")}</label>
              <select
                id="postcode"
                required
                value={details.postcode}
                onChange={(event) =>
                  onChange({ ...details, postcode: event.target.value })
                }
              >
                <option value="">{t("book.choosePostcode")}</option>
                {list.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
              <span className="hint">{t("book.postcodeHint")}</span>
            </div>
          )}
        </ResourceState>
        {service.pricing === "hourly" ? (
          <p className="info">
            <Icon name="clock" />
            {t("book.hourly", {
              rate: euro(service.priceCents),
              hours: service.durationMinutes / 60,
            })}
          </p>
        ) : (
          <fieldset className="sizes">
            <legend className="h-sm">{t(`book.sizeTitle.${sizeGroup}`)}</legend>
            {SIZES.map((size) => (
              <label
                key={size}
                className={`size ${details.size === size ? "on" : ""}`}
              >
                <input
                  type="radio"
                  name="size"
                  className="visually-hidden"
                  checked={details.size === size}
                  onChange={() => onChange({ ...details, size })}
                />
                <span className="n">{t(`book.size.${size}`)}</span>
                <span className="d">
                  {t(`book.sizeHint.${sizeGroup}.${size}`)}
                </span>
                <span className="b small brand-text">
                  {euro(sizePrice(service, size))}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="field">
          <label htmlFor="notes">{t("book.notes")}</label>
          <textarea
            id="notes"
            rows={3}
            maxLength={1000}
            placeholder={t("book.notesPlaceholder")}
            value={details.notes}
            onChange={(event) =>
              onChange({ ...details, notes: event.target.value })
            }
          />
        </div>
        <div className="info">
          <Icon name="tag" />
          <p>
            {t("book.fixedPrice", {
              price: euro(sizePrice(service, details.size)),
            })}
          </p>
        </div>
      </div>
      <div className="cta-bar">
        <button
          className="cta"
          type="submit"
          disabled={!details.address.trim() || !details.postcode}
        >
          {t("book.continuePrice", {
            price: euro(sizePrice(service, details.size)),
          })}
        </button>
      </div>
    </form>
  );
}

function TimeStep({
  service,
  postcode,
  slot,
  onSlot,
  onNext,
}: {
  service: Service;
  postcode: string;
  slot: Slot | null;
  onSlot: (slot: Slot) => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const load = useCallback(
    () =>
      api.get<{ slots: Slot[] }>(
        `/availability?serviceId=${encodeURIComponent(service.id)}&postcode=${encodeURIComponent(postcode)}`,
      ),
    [api, service.id, postcode],
  );
  const { state, reload } = useResource(load);
  const [day, setDay] = useState<string | null>(null);

  return (
    <>
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ slots }) => {
            const days = [
              ...new Set(slots.map((s) => dayKey(s.startsAt, timezone))),
            ];
            const shownDay =
              day ??
              days.find((d) =>
                slots.some(
                  (s) => s.available && dayKey(s.startsAt, timezone) === d,
                ),
              ) ??
              days[0];
            const daySlots = slots.filter(
              (s) => dayKey(s.startsAt, timezone) === shownDay,
            );
            const freeCount = daySlots.filter((s) => s.available).length;
            if (!slots.some((s) => s.available)) {
              return <p className="card">{t("book.noSlots")}</p>;
            }
            return (
              <>
                <fieldset>
                  <legend className="h-sm">{t("book.day")}</legend>
                  <div className="days">
                    {days.map((d) => {
                      const first = slots.find(
                        (s) => dayKey(s.startsAt, timezone) === d,
                      );
                      const parts = first
                        ? dayParts(first.startsAt, timezone)
                        : null;
                      return (
                        <button
                          key={d}
                          type="button"
                          className={`day ${d === shownDay ? "on" : ""}`}
                          aria-pressed={d === shownDay}
                          onClick={() => setDay(d)}
                        >
                          <span className="dn">{parts?.weekday}</span>
                          <span className="dd">{parts?.day}</span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="h-sm">{t("book.times")}</legend>
                  <div className="slots">
                    {daySlots.map((s) => (
                      <button
                        key={s.startsAt}
                        type="button"
                        className={`slot ${s.available ? "" : "off"} ${slot?.startsAt === s.startsAt ? "on" : ""}`}
                        disabled={!s.available}
                        aria-pressed={slot?.startsAt === s.startsAt}
                        onClick={() => onSlot(s)}
                      >
                        {time(s.startsAt, timezone)}
                        <small>
                          {s.available
                            ? t("book.prosFree", { count: s.freePros })
                            : t("book.full")}
                        </small>
                      </button>
                    ))}
                  </div>
                </fieldset>
                <div className="info">
                  <Icon name="users" />
                  <p>
                    {t("book.slotsFree", {
                      free: freeCount,
                      total: daySlots.length,
                    })}
                  </p>
                </div>
              </>
            );
          }}
        </ResourceState>
      </div>
      <div className="cta-bar">
        <button className="cta" type="button" disabled={!slot} onClick={onNext}>
          {slot
            ? t("book.continueAt", { when: dateTime(slot.startsAt, timezone) })
            : t("book.pickTime")}
        </button>
      </div>
    </>
  );
}

function ReviewStep({
  service,
  details,
  slot,
}: {
  service: Service;
  details: Details;
  slot: Slot;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const { timezone, feeCents } = useMarket();
  const { run, busy, error } = useAction();
  const [created, setCreated] = useState<{
    booking: CustomerBooking;
    payment: PaymentStep;
  } | null>(null);
  const price = sizePrice(service, details.size);
  const total = price + feeCents;

  async function book() {
    const result = await run(() =>
      api.post<{ booking: CustomerBooking; payment: PaymentStep | null }>(
        "/bookings",
        {
          serviceId: service.id,
          size: details.size,
          address: details.address,
          postcode: details.postcode,
          notes: details.notes,
          startsAt: slot.startsAt,
        },
      ),
    );
    if (!result) {
      return;
    }
    if (result.payment) {
      setCreated({ booking: result.booking, payment: result.payment });
    } else {
      navigate(`/bookings/${result.booking.id}`, { replace: true });
    }
  }

  return (
    <>
      <div className="body">
        <section className="card" aria-label={t("book.summary")}>
          <p className="b">{service.name}</p>
          <p className="small muted">{t(`book.size.${details.size}`)}</p>
          <hr />
          <p className="row small">
            <Icon name="calendar" /> {dateTime(slot.startsAt, timezone)}
          </p>
          <p className="row small">
            <Icon name="pin" /> {details.address}, {details.postcode}
          </p>
        </section>
        <section className="card" aria-label={t("book.price")}>
          <p className="line">
            <span>{service.name}</span>
            <span>{euro(price)}</span>
          </p>
          <p className="line">
            <span className="muted">{t("book.fee")}</span>
            <span>{euro(feeCents)}</span>
          </p>
          <p className="line total">
            <span>{t("book.total")}</span>
            <span>{euro(total)}</span>
          </p>
        </section>
        {created ? (
          <section aria-label={t("pay.title")}>
            <h2 className="h-sm">{t("pay.title")}</h2>
            <CardPayment
              payment={created.payment}
              amountLabel={euro(created.booking.totalCents)}
              onConfirmed={() =>
                navigate(`/bookings/${created.booking.id}`, { replace: true })
              }
            />
          </section>
        ) : (
          <div className="info">
            <Icon name="shield" />
            <p>{t("book.holdExplained")}</p>
          </div>
        )}
        <ErrorText error={error} />
      </div>
      {!created && (
        <div className="cta-bar">
          <button
            className="cta"
            type="button"
            disabled={busy}
            onClick={() => void book()}
          >
            <Icon name="lock" />{" "}
            {busy
              ? t("book.booking")
              : t("book.bookAndPay", { amount: euro(total) })}
          </button>
        </div>
      )}
    </>
  );
}

export function BookPage() {
  const { t } = useTranslation();
  const { serviceId } = useParams();
  const market = useMarket();
  const [step, setStep] = useState<"details" | "time" | "review">("details");
  const [details, setDetails] = useState<Details>({
    address: "",
    postcode: "",
    size: "M",
    notes: "",
  });
  const [slot, setSlot] = useState<Slot | null>(null);

  const category = market.categories.find((c) =>
    c.services.some((s) => s.id === serviceId),
  );
  const service = category?.services.find((s) => s.id === serviceId);

  if (!category || !service) {
    return <Navigate to="/" replace />;
  }
  const titles = {
    details: service.name,
    time: t("book.chooseTime"),
    review: t("book.reviewTitle"),
  };

  return (
    <>
      {step === "details" ? (
        <AppHeader title={titles.details} back={`/category/${category.slug}`} />
      ) : (
        <header className="appbar">
          <button
            type="button"
            className="iconbtn"
            aria-label={t("common.back")}
            onClick={() => setStep(step === "review" ? "time" : "details")}
          >
            <Icon name="chevL" />
          </button>
          <h1>{titles[step]}</h1>
        </header>
      )}
      <ol className="progress-steps" aria-label={t("book.progress")}>
        {(["details", "time", "review"] as const).map((s) => (
          <li
            key={s}
            className={s === step ? "on" : ""}
            aria-current={s === step ? "step" : undefined}
          >
            {t(`book.steps.${s}`)}
          </li>
        ))}
      </ol>
      {step === "details" && (
        <DetailsStep
          service={service}
          isGarden={category.icon === "leaf" || category.icon === "sun"}
          details={details}
          onChange={(next) => {
            if (next.postcode !== details.postcode) {
              setSlot(null);
            }
            setDetails(next);
          }}
          onNext={() => setStep("time")}
        />
      )}
      {step === "time" && (
        <TimeStep
          service={service}
          postcode={details.postcode}
          slot={slot}
          onSlot={setSlot}
          onNext={() => setStep("review")}
        />
      )}
      {step === "review" && slot && (
        <ReviewStep service={service} details={details} slot={slot} />
      )}
    </>
  );
}

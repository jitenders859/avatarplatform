"use client";

import { useState } from "react";

const DOW_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function dateKey(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

interface CalendarProps {
  /** "YYYY-MM-DD" dates that have at least one bookable window. */
  availableDates: Set<string>;
  selectedDate: string | null;
  onSelect: (date: string) => void;
}

/** A small dependency-free month-grid calendar. Only dates in `availableDates` are clickable. */
export default function Calendar({ availableDates, selectedDate, onSelect }: CalendarProps) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const startWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayKey = dateKey(today.getFullYear(), today.getMonth() + 1, today.getDate());

  const cells: (number | null)[] = [...Array(startWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  function goPrev() {
    setViewMonth((m) => (m === 0 ? 11 : m - 1));
    setViewYear((y) => (viewMonth === 0 ? y - 1 : y));
  }
  function goNext() {
    setViewMonth((m) => (m === 11 ? 0 : m + 1));
    setViewYear((y) => (viewMonth === 11 ? y + 1 : y));
  }

  return (
    <div className="calendar">
      <div className="calendar-header">
        <button type="button" className="btn btn-secondary" onClick={goPrev} aria-label="Previous month">
          ‹
        </button>
        <strong>{firstOfMonth.toLocaleString(undefined, { month: "long", year: "numeric" })}</strong>
        <button type="button" className="btn btn-secondary" onClick={goNext} aria-label="Next month">
          ›
        </button>
      </div>
      <div className="calendar-grid">
        {DOW_LABELS.map((d) => (
          <div key={d} className="calendar-dow">
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`empty-${i}`} />;
          const key = dateKey(viewYear, viewMonth + 1, day);
          const available = availableDates.has(key);
          const isPast = key < todayKey;
          const clickable = available && !isPast;
          return (
            <button
              type="button"
              key={key}
              disabled={!clickable}
              className={`calendar-day${clickable ? " available" : ""}${key === selectedDate ? " selected" : ""}`}
              onClick={() => onSelect(key)}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

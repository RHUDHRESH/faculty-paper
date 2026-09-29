"""One guard against spreadsheet formula injection, for every export.

Paper titles, journal names, faculty names, notes and department names are
user-supplied and land in files somebody opens in Excel or LibreOffice, where a
cell starting with ``= + - @`` (or a tab / carriage return ahead of one) is run
as a formula. Every CSV and XLSX writer in the app goes through this module:

- ``safe_cell`` prefixes such a *string* with a single quote. Numbers, dates
  and ``None`` pass through untouched, so figures stay figures.
- ``csv_writer`` / ``dict_writer`` are ``csv.writer`` / ``csv.DictWriter``
  whose rows are escaped on the way in.
- ``safe_append`` / ``safe_set`` put a row / a value into an openpyxl sheet
  escaped, and force every string cell to the string type so openpyxl never
  stores it as a formula.
"""
from __future__ import annotations

import csv
from typing import Any, Iterable

_DANGEROUS = ("=", "+", "-", "@", "\t", "\r")


def safe_cell(value: Any) -> Any:
    if isinstance(value, str) and value[:1] in _DANGEROUS:
        return "'" + value
    return value


def safe_row(values: Iterable[Any]) -> list[Any]:
    return [safe_cell(v) for v in values]


class _SafeWriter:
    def __init__(self, inner):
        self._inner = inner

    def writerow(self, row):
        return self._inner.writerow(safe_row(row))

    def writerows(self, rows):
        for row in rows:
            self.writerow(row)

    def __getattr__(self, name):
        return getattr(self._inner, name)


def csv_writer(buf, *args, **kwargs) -> _SafeWriter:
    return _SafeWriter(csv.writer(buf, *args, **kwargs))


class _SafeDictWriter(csv.DictWriter):
    def writerow(self, rowdict):
        return super().writerow({k: safe_cell(v) for k, v in rowdict.items()})

    def writerows(self, rowdicts):
        for r in rowdicts:
            self.writerow(r)


def dict_writer(buf, fieldnames, *args, **kwargs) -> csv.DictWriter:
    return _SafeDictWriter(buf, fieldnames, *args, **kwargs)


def _force_string(cell) -> None:
    if isinstance(cell.value, str):
        cell.data_type = "s"


def safe_append(ws, row: Iterable[Any]) -> None:
    """``ws.append(row)`` with every string escaped and stored as a string."""
    ws.append(safe_row(row))
    for cell in ws[ws.max_row]:
        _force_string(cell)


def safe_set(ws, row: int, column: int, value: Any):
    """``ws.cell(row=, column=, value=)`` escaped; returns the cell."""
    cell = ws.cell(row=row, column=column, value=safe_cell(value))
    _force_string(cell)
    return cell

"""The single error shape every /api endpoint returns (PLAN.md §8).

Any non-2xx body is `{"error": {"code": "...", "message": "..."}}`. Handlers
registered in main.py funnel ApiError, FastAPI validation failures, bare
HTTPExceptions and unhandled exceptions into that one envelope so the frontend
never has to branch on error format.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)

# code -> (http status, default human-readable message)
ERROR_CATALOG: dict[str, tuple[int, str]] = {
    "validation_error": (422, "Request body is malformed or missing required fields."),
    "invalid_ticker": (400, "Ticker symbol is not valid."),
    "invalid_side": (400, "Trade side must be 'buy' or 'sell'."),
    "not_watchlisted": (404, "That ticker is not on the watchlist."),
    "no_position": (404, "You have no open position in that ticker."),
    "duplicate_ticker": (409, "That ticker is already on the watchlist."),
    "insufficient_cash": (400, "Not enough cash to complete this purchase."),
    "insufficient_shares": (400, "Not enough shares to complete this sale."),
    "quote_unavailable": (409, "No price is available for that ticker yet — try again shortly."),
    "chat_unavailable": (503, "AI chat is not configured — set OPENROUTER_API_KEY to enable it."),
    "not_found": (404, "Resource not found."),
    "internal_error": (500, "An unexpected server error occurred."),
}


class ApiError(Exception):
    """Raise anywhere in a request path to produce a §8 error response.

    >>> raise ApiError("insufficient_cash")
    >>> raise ApiError("insufficient_cash", "Buying 10 AAPL needs $1,912.00; you have $50.00.")
    """

    def __init__(self, code: str, message: str | None = None, status_code: int | None = None):
        default_status, default_message = ERROR_CATALOG.get(code, (400, code))
        self.code = code
        self.message = message or default_message
        self.status_code = status_code or default_status
        super().__init__(self.message)

    def to_response(self) -> JSONResponse:
        return error_response(self.code, self.message, self.status_code)


def error_response(code: str, message: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message}},
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Install the handlers that normalize every error into the §8 envelope."""

    @app.exception_handler(ApiError)
    async def _handle_api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return exc.to_response()

    @app.exception_handler(RequestValidationError)
    async def _handle_validation_error(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # FastAPI would emit its own 422 {"detail": [...]} body; rewrite it.
        detail = _first_validation_message(exc)
        return error_response("validation_error", detail, 422)

    @app.exception_handler(StarletteHTTPException)
    async def _handle_http_exception(
        _request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        code = _code_for_status(exc.status_code)
        fallback = ERROR_CATALOG.get(code, (exc.status_code, "Request failed."))[1]
        message = exc.detail if isinstance(exc.detail, str) and exc.detail else fallback
        return error_response(code, message, exc.status_code)

    @app.exception_handler(Exception)
    async def _handle_unexpected(_request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled server error: %s", exc)
        code, message = "internal_error", ERROR_CATALOG["internal_error"][1]
        return error_response(code, message, 500)


def _code_for_status(status_code: int) -> str:
    """Map a bare HTTP status onto a §8 error code."""
    if status_code == 404:
        return "not_found"
    if status_code == 422:
        return "validation_error"
    if status_code >= 500:
        return "internal_error"
    return "validation_error"


def _first_validation_message(exc: RequestValidationError) -> str:
    """Turn pydantic's error list into one readable sentence."""
    errors = exc.errors()
    if not errors:
        return ERROR_CATALOG["validation_error"][1]
    first = errors[0]
    location = ".".join(str(part) for part in first.get("loc", ()) if part != "body")
    reason = first.get("msg", "is invalid")
    return f"{location or 'request body'}: {reason}"

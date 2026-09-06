import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "@/lib/auth";

/** Uniform error handling for Route Handlers: Zod validation, AuthError, and everything else. */
export function apiError(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return NextResponse.json({ error: "Invalid input", details: err.flatten() }, { status: 400 });
  }
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof Error) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error(err);
  return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
}

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import AppErrorBoundary from "./AppErrorBoundary";

describe("AppErrorBoundary", () => {
  afterEach(cleanup);

  it("renders children when nothing throws", () => {
    render(() => (
      <AppErrorBoundary>
        <p>all good</p>
      </AppErrorBoundary>
    ));
    expect(screen.getByText("all good")).toBeInTheDocument();
  });

  it("shows the error message and reassures that local data is safe", () => {
    const Boom = () => {
      throw new Error("kaboom");
    };
    render(() => (
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>
    ));
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("kaboom")).toBeInTheDocument();
    expect(screen.getByText(/stored locally/)).toBeInTheDocument();
  });

  it("re-renders children after Try again once the cause is gone", () => {
    const [shouldThrow, setShouldThrow] = createSignal(true);
    const MaybeBoom = () => {
      if (shouldThrow()) {
        throw new Error("transient");
      }
      return <p>recovered</p>;
    };
    render(() => (
      <AppErrorBoundary>
        <MaybeBoom />
      </AppErrorBoundary>
    ));
    expect(screen.getByText("transient")).toBeInTheDocument();

    setShouldThrow(false);
    screen.getByRole("button", { name: /try again/i }).click();
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
});

import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LicenceNoticesRow } from "../LicenceNoticesRow";

const invokeMock = vi.mocked(invoke);

describe("LicenceNoticesRow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("opens the licence and third-party notices file when the link is clicked", () => {
    invokeMock.mockResolvedValue(undefined);
    render(<LicenceNoticesRow />);

    fireEvent.click(screen.getByRole("button", { name: "Licence and third-party notices" }));

    expect(invokeMock).toHaveBeenCalledWith("open_third_party_notices");
  });

  it("says why when the notices file cannot be opened", async () => {
    invokeMock.mockRejectedValue("The notices file is missing from this copy of Maestro");
    render(<LicenceNoticesRow />);

    fireEvent.click(screen.getByRole("button", { name: "Licence and third-party notices" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The notices file is missing from this copy of Maestro",
    );
  });
});

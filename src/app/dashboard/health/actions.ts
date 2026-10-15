"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAgencyStaffOr404 } from "@/lib/access";
import { refreshClientHealth } from "@/lib/health/refresh";

// Agency-only, checked here too: Server Actions can be called directly.
export async function refreshHealthAction(form: FormData) {
  await requireAgencyStaffOr404();
  const report = await refreshClientHealth();
  const failed = report.filter((r) => !r.ok).length;
  const show = String(form.get("show") ?? "");
  revalidatePath("/dashboard/health");
  redirect(
    `/dashboard/health?${new URLSearchParams({
      ...(show && { show }),
      refreshed: String(report.length - failed),
      ...(failed ? { failed: String(failed) } : {}),
    })}`,
  );
}

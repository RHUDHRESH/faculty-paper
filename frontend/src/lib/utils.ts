import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function portalPath(portal?: string | null) {
  if (portal === "admin") return "/admin";
  if (portal === "finance") return "/finance";
  if (portal === "principal") return "/principal";
  if (portal === "hod") return "/hod";
  return "/faculty";
}

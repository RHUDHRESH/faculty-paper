/** Every page in the app, with the role that can reach it. */
export const ACCOUNTS = {
  faculty:   { email: "faculty@college.edu",   password: "faculty123" },
  admin:     { email: "admin@college.edu",     password: "admin123" },
  finance:   { email: "finance@college.edu",   password: "finance123" },
  principal: { email: "principal@college.edu", password: "principal123" },
}

export const PAGES = [
  { role: "faculty",   path: "/faculty",          name: "Faculty · my tickets" },
  { role: "faculty",   path: "/faculty/new",      name: "Faculty · new ticket" },
  { role: "faculty",   path: "/faculty/profile",  name: "Faculty · profile" },

  { role: "admin",     path: "/admin",            name: "Admin · overview" },
  { role: "admin",     path: "/admin/clearing",   name: "Admin · clearing queue" },
  { role: "admin",     path: "/admin/submit",     name: "Admin · submit for faculty" },
  { role: "admin",     path: "/admin/users",      name: "Admin · users" },
  { role: "admin",     path: "/admin/formula",    name: "Admin · formula" },
  { role: "admin",     path: "/admin/scimago",    name: "Admin · imports" },
  { role: "admin",     path: "/admin/prior",      name: "Admin · prior payments" },
  { role: "admin",     path: "/admin/monthly",    name: "Admin · monthly" },
  { role: "admin",     path: "/admin/query",      name: "Admin · query" },
  { role: "admin",     path: "/admin/reports",    name: "Admin · reports" },
  { role: "admin",     path: "/admin/audit",      name: "Admin · audit" },

  { role: "finance",   path: "/finance",          name: "Finance · payment orders" },
  { role: "finance",   path: "/finance/paid",     name: "Finance · processed" },
  { role: "finance",   path: "/finance/ledger",   name: "Finance · ledger" },
  { role: "finance",   path: "/finance/query",    name: "Finance · query" },
  { role: "finance",   path: "/finance/reports",  name: "Finance · reports" },
  { role: "finance",   path: "/finance/formula",  name: "Finance · formula" },

  { role: "principal", path: "/principal",        name: "Principal · overview" },
  { role: "principal", path: "/principal/overview", name: "Principal · overview page" },
  { role: "principal", path: "/principal/reports",name: "Principal · reports" },
  { role: "principal", path: "/principal/query",  name: "Principal · query" },
]

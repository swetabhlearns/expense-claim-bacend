import { forbidden, unauthorized } from "./errors.mjs";

let adminAppPromise;

async function getFirebaseAdmin(config) {
  if (adminAppPromise) return adminAppPromise;
  adminAppPromise = (async () => {
    const adminImport = await import("firebase-admin");
    const admin = adminImport.default ?? adminImport;
    const initializeApp = typeof admin.initializeApp === "function" ? admin.initializeApp.bind(admin) : null;
    const credential = admin.credential ?? adminImport.credential ?? null;
    const apps = Array.isArray(admin.apps) ? admin.apps : [];

    if (apps.length === 0 && initializeApp) {
      const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (serviceAccountJson && credential?.cert && initializeApp) {
        initializeApp({
          credential: credential.cert(JSON.parse(serviceAccountJson)),
          projectId: config.firebaseProjectId,
        });
      } else if (initializeApp) {
        initializeApp({ projectId: config.firebaseProjectId });
      }
    }
    return admin;
  })();
  return adminAppPromise;
}

function normalizeEmail(value) {
  return value?.trim().toLowerCase() || null;
}

async function findUserByIdentity(db, identity, demoUserId) {
  if (demoUserId) {
    const demoUser = await db.collection("users").findOne({ _id: demoUserId });
    if (demoUser) return demoUser;
  }

  const email = normalizeEmail(identity?.email);
  if (!email) return null;
  return await db.collection("users").findOne({ email });
}

export async function getRequestIdentity(req, config) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

  if (!token) {
    if (config.allowUnverifiedAuth) {
      const email = normalizeEmail(req.headers["x-user-email"]);
      const userId = req.headers["x-demo-user-id"] || req.headers["x-user-id"];
      return { email, uid: userId || email || "unverified-test-user", unverified: true };
    }
    return null;
  }

  if (config.allowUnverifiedAuth && token.startsWith("test:")) {
    return { email: normalizeEmail(token.slice("test:".length)), uid: token, unverified: true };
  }

  const admin = await getFirebaseAdmin(config);
  const authApi =
    typeof admin.getAuth === "function"
      ? admin.getAuth()
      : typeof admin.auth === "function"
        ? admin.auth()
        : null;
  if (!authApi || typeof authApi.verifyIdToken !== "function") {
    throw new Error("firebase-admin auth API is unavailable");
  }
  return await authApi.verifyIdToken(token);
}

export async function getCurrentUser(ctx, args = {}) {
  const identity = await getRequestIdentity(ctx.req, ctx.config);
  return await findUserByIdentity(ctx.db, identity, args.demoUserId);
}

export async function requireCurrentUser(ctx, args = {}) {
  const user = await getCurrentUser(ctx, args);
  if (!user) throw unauthorized();
  if ((user.status || "active") !== "active") throw forbidden("Your account is inactive");
  return user;
}

export function canManageRoles(role) {
  return role === "ROLE_MANAGER" || role === "L3_ADMIN" || role === "CEO_ADMIN";
}

export function canViewAdmin(role) {
  return ["L1_ADMIN", "L2_ADMIN", "L3_ADMIN", "L4_ADMIN", "CEO_ADMIN", "ROLE_MANAGER"].includes(role);
}

export function canViewFinance(role) {
  return ["L3_ADMIN", "L4_ADMIN", "CEO_ADMIN"].includes(role);
}

export function canViewAnalytics(user) {
  return user.role === "MONITOR" || user.role === "ROLE_MANAGER" || user.role === "L3_ADMIN" || user.role === "L4_ADMIN" || user.role === "CEO_ADMIN" || user.canViewMonitoring;
}

export function canViewVendorLedger(user) {
  return Boolean(user.canManageVendors) || user.role === "L3_ADMIN" || user.role === "L4_ADMIN" || user.role === "CEO_ADMIN";
}

export function assertRoleManager(user) {
  if (!canManageRoles(user.role)) throw forbidden("Only Role Manager, L3 Admin, or CEO Admin can perform this action");
}

export function assertVendorManager(user) {
  if (!user.canManageVendors && user.role !== "L3_ADMIN" && user.role !== "L4_ADMIN" && user.role !== "CEO_ADMIN") {
    throw forbidden("You do not have permission to manage vendors");
  }
}

export function assertCanAccessClaim(user, claim) {
  if (canViewAdmin(user.role) || canViewFinance(user.role) || canViewAnalytics(user)) return;
  if (String(claim.userId) === String(user._id)) return;
  throw forbidden("You do not have permission to view this claim");
}

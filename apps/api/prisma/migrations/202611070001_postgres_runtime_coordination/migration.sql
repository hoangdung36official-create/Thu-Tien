-- Redis-free runtime coordination for Vercel/Render.
CREATE TABLE "LoginAttempt" (
    "key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "Lease" (
    "key" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Lease_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "LoginAttempt_expiresAt_idx" ON "LoginAttempt"("expiresAt");
CREATE INDEX "Lease_expiresAt_idx" ON "Lease"("expiresAt");

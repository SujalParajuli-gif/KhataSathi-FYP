-- Active accounts can sign in and therefore require one canonical Nepali
-- mobile number. Archived legacy identities may keep NULL so financial and
-- audit history can remain attached without inventing contact information.
ALTER TABLE `User`
  ADD CONSTRAINT `User_active_phone_chk`
  CHECK (
    `isActive` = 0
    OR (`phone` IS NOT NULL AND `phone` REGEXP '^[+]9779[0-9]{9}$')
  );

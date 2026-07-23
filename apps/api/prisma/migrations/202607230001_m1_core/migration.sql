-- CreateTable
CREATE TABLE `admin_user` (
    `id` VARCHAR(191) NOT NULL,
    `username` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
    `failedLoginCount` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    UNIQUE INDEX `admin_user_username_key`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_account` (
    `id` VARCHAR(191) NOT NULL,
    `normalizedPhone` VARCHAR(20) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
    `isProvisional` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    UNIQUE INDEX `member_account_normalizedPhone_key`(`normalizedPhone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `wechat_identity` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `openId` VARCHAR(128) NOT NULL,
    `unionId` VARCHAR(128) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    UNIQUE INDEX `wechat_identity_openId_key`(`openId`),
    INDEX `wechat_identity_unionId_idx`(`unionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `refresh_session` (
    `id` VARCHAR(191) NOT NULL,
    `adminUserId` VARCHAR(191) NULL,
    `memberAccountId` VARCHAR(191) NULL NULL,
    `tokenHash` VARCHAR(128) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `student_profile` (
    `id` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(50) NOT NULL,
    `birthDate` DATE NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `account_student_relation` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `relationType` VARCHAR(20) NOT NULL,
    `verifiedByAdminId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    UNIQUE INDEX `account_student_relation_accountId_studentId_key`(`accountId`, `studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `course` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `description` TEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `package_product` (
    `id` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `price` DECIMAL(10,2) NOT NULL,
    `hours` DECIMAL(10,2) NOT NULL,
    `validDays` INTEGER NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `offline_order` (
    `id` VARCHAR(191) NOT NULL,
    `buyerAccountId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `totalAmount` DECIMAL(10,2) NOT NULL,
    `confirmedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `order_item` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `productNameSnapshot` VARCHAR(100) NOT NULL,
    `unitPriceSnapshot` DECIMAL(10,2) NOT NULL,
    `hoursSnapshot` DECIMAL(10,2) NOT NULL,
    `validDaysSnapshot` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    UNIQUE INDEX `order_item_id_key`(`id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `course_package` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `sourceType` VARCHAR(20) NOT NULL,
    `sourceOrderItemId` VARCHAR(191) NULL,
    `startsOn` DATE NOT NULL,
    `expiresOn` DATE NOT NULL,
    `granted` DECIMAL(10,2) NOT NULL,
    `available` DECIMAL(10,2) NOT NULL,
    `reserved` DECIMAL(10,2) NOT NULL,
    `consumed` DECIMAL(10,2) NOT NULL,
    `expired` DECIMAL(10,2) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    UNIQUE INDEX `course_package_sourceOrderItemId_key`(`sourceOrderItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `student_course_balance` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `available` DECIMAL(10,2) NOT NULL,
    `reserved` DECIMAL(10,2) NOT NULL,
    `consumed` DECIMAL(10,2) NOT NULL,
    `expired` DECIMAL(10,2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    UNIQUE INDEX `student_course_balance_studentId_courseId_key`(`studentId`, `courseId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `hour_transaction` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(30) NOT NULL,
    `businessKey` VARCHAR(200) NOT NULL,
    `availableDelta` DECIMAL(10,2) NOT NULL,
    `reservedDelta` DECIMAL(10,2) NOT NULL,
    `consumedDelta` DECIMAL(10,2) NOT NULL,
    `expiredDelta` DECIMAL(10,2) NOT NULL,
    `reason` TEXT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `hour_transaction_businessKey_key`(`businessKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `hour_allocation` (
    `id` VARCHAR(191) NOT NULL,
    `transactionId` VARCHAR(191) NOT NULL,
    `packageId` VARCHAR(191) NOT NULL,
    `sourceType` VARCHAR(20) NOT NULL,
    `sourceId` VARCHAR(191) NOT NULL,
    `availableDelta` DECIMAL(10,2) NOT NULL,
    `reservedDelta` DECIMAL(10,2) NOT NULL,
    `consumedDelta` DECIMAL(10,2) NOT NULL,
    `expiredDelta` DECIMAL(10,2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `idempotency_record` (
    `id` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(50) NOT NULL,
    `actorId` VARCHAR(100) NOT NULL,
 `key` VARCHAR(100) NOT NULL,
    `requestHash` VARCHAR(128) NOT NULL,
    `state` VARCHAR(191) NOT NULL DEFAULT 'IN_PROGRESS',
    `responseStatus` INTEGER NULL,
    `responseBody` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    UNIQUE INDEX `idempotency_record_scope_actorId_key_key`(`scope`, `actorId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign Keys
ALTER TABLE `wechat_identity` ADD CONSTRAINT `wechat_identity_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `member_account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `refresh_session` ADD CONSTRAINT `refresh_session_adminUserId_fkey` FOREIGN KEY (`adminUserId`) REFERENCES `admin_user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `refresh_session` ADD CONSTRAINT `refresh_session_memberAccountId_fkey` FOREIGN KEY (`memberAccountId`) REFERENCES `member_account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `account_student_relation` ADD CONSTRAINT `account_student_relation_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `member_account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `account_student_relation` ADD CONSTRAINT `account_student_relation_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `student_profile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `package_product` ADD CONSTRAINT `package_product_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `course`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `offline_order` ADD CONSTRAINT `offline_order_buyerAccountId_fkey` FOREIGN KEY (`buyerAccountId`) REFERENCES `member_account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `order_item` ADD CONSTRAINT `order_item_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `offline_order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `order_item` ADD CONSTRAINT `order_item_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `student_profile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `order_item` ADD CONSTRAINT `order_item_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `package_product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `order_item` ADD CONSTRAINT `order_item_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `course`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `course_package` ADD CONSTRAINT `course_package_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `student_profile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `course_package` ADD CONSTRAINT `course_package_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `course`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `course_package` ADD CONSTRAINT `course_package_sourceOrderItemId_fkey` FOREIGN KEY (`sourceOrderItemId`) REFERENCES `order_item`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `student_course_balance` ADD CONSTRAINT `student_course_balance_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `student_profile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `student_course_balance` ADD CONSTRAINT `student_course_balance_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `course`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `hour_transaction` ADD CONSTRAINT `hour_transaction_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `student_profile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `hour_transaction` ADD CONSTRAINT `hour_transaction_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `course`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `hour_allocation` ADD CONSTRAINT `hour_allocation_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `hour_transaction`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `hour_allocation` ADD CONSTRAINT `hour_allocation_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `course_package`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

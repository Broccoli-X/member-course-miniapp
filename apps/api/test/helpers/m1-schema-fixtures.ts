import { PrismaClient } from '../../src/generated/prisma/client.js';

export async function seedMemberStudentCourse(db: PrismaClient): Promise<{
  accountId: string;
  studentId: string;
  courseId: string;
}> {
  const account = await db.memberAccount.create({
    data: {
      id: 'test-account-1',
      normalizedPhone: '13800000001',
    },
  });

  const student = await db.studentProfile.create({
    data: { id: 'test-student-1', displayName: '小明' },
  });

  await db.accountStudentRelation.create({
    data: {
      accountId: account.id,
      studentId: student.id,
      relationType: 'PARENT',
    },
  });

  const course = await db.course.create({
    data: {
      id: 'test-course-1',
      name: '少儿编程',
      type: 'CLASS',
      description: 'Scratch 入门班',
    },
  });

  await db.studentCourseBalance.create({
    data: {
      studentId: student.id,
      courseId: course.id,
      available: 0,
      reserved: 0,
      consumed: 0,
      expired: 0,
    },
  });

  return { accountId: account.id, studentId: student.id, courseId: course.id };
}

export async function createDuplicateBalance(db: PrismaClient): Promise<unknown> {
  return db.studentCourseBalance.create({
    data: {
      studentId: 'test-student-1',
      courseId: 'test-course-1',
      available: 0,
      reserved: 0,
      consumed: 0,
      expired: 0,
    },
  });
}

export async function createDuplicateAccountStudentRelation(db: PrismaClient): Promise<unknown> {
  return db.accountStudentRelation.create({
    data: {
      accountId: 'test-account-1',
      studentId: 'test-student-1',
      relationType: 'GUARDIAN',
    },
  });
}

export async function createDuplicateIdempotencyKey(db: PrismaClient): Promise<unknown> {
  return db.idempotencyRecord.create({
    data: {
      scope: 'order-confirm',
      actorId: 'admin-1',
      key: 'order-1',
      requestHash: 'abc123',
    },
  });
}

export async function seedConfirmedOrderFixture(db: PrismaClient): Promise<{
  courseId: string;
  studentId: string;
}> {
  const { studentId, courseId } = await seedMemberStudentCourse(db);

  const product = await db.packageProduct.create({
    data: {
      id: 'test-product-1',
      courseId,
      name: '10课时包',
      price: 1000,
      hours: 10,
      validDays: 90,
    },
  });

  const order = await db.offlineOrder.create({
    data: {
      id: 'test-order-1',
      buyerAccountId: 'test-account-1',
      status: 'CONFIRMED',
      totalAmount: 1000,
      confirmedAt: new Date(),
    },
  });

  await db.orderItem.create({
    data: {
      id: 'test-order-item-1',
      orderId: order.id,
      studentId,
      productId: product.id,
      courseId,
      productNameSnapshot: '10课时包',
      unitPriceSnapshot: 1000,
      hoursSnapshot: 10,
      validDaysSnapshot: 90,
    },
  });

  return { courseId, studentId };
}

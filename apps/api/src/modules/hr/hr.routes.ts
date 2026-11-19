import { ATTENDANCE_STATUSES } from '@erp/domain';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { idParam } from '../admin/crud';
import { pinSchema } from '../auth/password';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import {
  addHoliday,
  attendanceMonth,
  attendanceSheet,
  clock,
  clockList,
  createEmployee,
  DEPARTMENTS,
  getEmployee,
  listEmployees,
  listHolidays,
  markAttendance,
  markMany,
  presentEmployee,
  removeHoliday,
  setEmployeePin,
  updateEmployee,
  type Actor,
} from './hr.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const month = z.string().regex(/^\d{4}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const opt = (max: number) => z.string().trim().max(max).nullable().optional();

const employeeBody = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,20}$/)
      .optional(),
    fullName: z.string().trim().min(1).max(120),
    fullNameUr: opt(120),
    phone: opt(30),
    cnic: opt(20),
    address: opt(300),
    emergencyContact: opt(120),
    designation: z.string().trim().max(60).optional(),
    department: z.enum(DEPARTMENTS).optional(),
    joinDate: isoDate,
    leftDate: isoDate.nullable().optional(),
    status: z.enum(['ACTIVE', 'ON_NOTICE', 'LEFT']).optional(),
    payType: z.enum(['MONTHLY', 'DAILY', 'HOURLY']).optional(),
    basePayPaisa: z.number().int().min(0).max(1_000_000_000_000).optional(),
    payFrequency: z.enum(['MONTHLY', 'WEEKLY', 'DAILY']).optional(),
    weeklyOff: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    shiftStart: hhmm.nullable().optional(),
    shiftEnd: hhmm.nullable().optional(),
    payoutMethod: z.enum(['CASH', 'JAZZCASH', 'EASYPAISA', 'BANK']).nullable().optional(),
    payoutAccount: opt(60),
    userId: z.string().uuid().nullable().optional(),
    notes: opt(500),
  })
  .strict();

export function hrRouter(ctx: AppContext): Router {
  const r = Router();
  const read = [authenticate(ctx), resolveBranch(ctx)];
  const viewEmp = [...read, requirePermission(ctx, 'employee.view')];
  const manageEmp = [...read, requirePermission(ctx, 'employee.manage')];
  const viewAtt = [...read, requirePermission(ctx, 'attendance.view')];
  const markAtt = [...read, requirePermission(ctx, 'attendance.mark')];
  const clockAtt = [...read, requirePermission(ctx, 'attendance.clock')];
  const actor = (req: Request): Actor => ({
    branchId: req.branchId!,
    userId: req.principal!.userId,
    deviceId: req.principal!.deviceId,
    ip: req.ip,
  });

  // ── employees (never deleted: someone who leaves gets status LEFT)
  r.get(
    '/employees',
    ...viewEmp,
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          status: z.enum(['ACTIVE', 'ON_NOTICE', 'LEFT', 'CURRENT']).optional(),
          q: z.string().max(60).optional(),
        })
        .parse(req.query);
      const rows = await listEmployees(ctx, req.branchId!, { status: q.status, q: q.q });
      res.json({ items: rows.map((e) => presentEmployee(e, { personal: true })) });
    }),
  );
  r.post(
    '/employees',
    ...manageEmp,
    asyncHandler(async (req, res) => {
      const row = await createEmployee(ctx, actor(req), employeeBody.parse(req.body));
      res.status(201).json(presentEmployee(row, { personal: true }));
    }),
  );
  r.get(
    '/employees/:id',
    ...viewEmp,
    asyncHandler(async (req, res) => {
      const row = await getEmployee(ctx.db, req.branchId!, idParam.parse(req.params).id);
      res.json(presentEmployee(row, { personal: true }));
    }),
  );
  r.patch(
    '/employees/:id',
    ...manageEmp,
    asyncHandler(async (req, res) => {
      const body = employeeBody.partial().parse(req.body);
      const row = await updateEmployee(ctx, actor(req), idParam.parse(req.params).id, body);
      res.json(presentEmployee(row, { personal: true }));
    }),
  );
  r.put(
    '/employees/:id/pin',
    ...manageEmp,
    asyncHandler(async (req, res) => {
      const { pin } = z.object({ pin: pinSchema }).strict().parse(req.body);
      await setEmployeePin(ctx, actor(req), idParam.parse(req.params).id, pin);
      res.status(204).end();
    }),
  );
  r.delete(
    '/employees/:id/pin',
    ...manageEmp,
    asyncHandler(async (req, res) => {
      await setEmployeePin(ctx, actor(req), idParam.parse(req.params).id, null);
      res.status(204).end();
    }),
  );

  // ── attendance
  r.get(
    '/attendance',
    ...viewAtt,
    asyncHandler(async (req, res) => {
      const { date } = z.object({ date: isoDate }).parse(req.query);
      res.json({ date, items: await attendanceSheet(ctx, req.branchId!, date) });
    }),
  );
  r.get(
    '/attendance/month',
    ...viewAtt,
    asyncHandler(async (req, res) => {
      const q = z.object({ month }).parse(req.query);
      res.json(await attendanceMonth(ctx, req.branchId!, q.month));
    }),
  );
  r.put(
    '/attendance/:employeeId/:date',
    ...markAtt,
    asyncHandler(async (req, res) => {
      const date = isoDate.parse(req.params.date);
      const body = z
        .object({
          status: z.enum(ATTENDANCE_STATUSES),
          clockIn: hhmm.nullable().optional(),
          clockOut: hhmm.nullable().optional(),
          clockOutNextDay: z.boolean().optional(),
          note: opt(200),
        })
        .strict()
        .parse(req.body);
      const employeeId = z.string().uuid().parse(req.params.employeeId);
      res.json(await markAttendance(ctx, actor(req), employeeId, date, body));
    }),
  );
  r.post(
    '/attendance/bulk',
    ...markAtt,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          date: isoDate,
          status: z.enum(ATTENDANCE_STATUSES),
          employeeIds: z.array(z.string().uuid()).min(1).max(500),
        })
        .strict()
        .parse(req.body);
      res.json(await markMany(ctx, actor(req), body.date, body.status, body.employeeIds));
    }),
  );

  // ── the clock-in / clock-out screen
  r.get(
    '/attendance-clock',
    ...clockAtt,
    asyncHandler(async (req, res) => {
      res.json({ items: await clockList(ctx, req.branchId!) });
    }),
  );
  r.post(
    '/attendance-clock',
    ...clockAtt,
    asyncHandler(async (req, res) => {
      const body = z
        .object({ employeeId: z.string().uuid(), pin: z.string().min(1).max(12) })
        .strict()
        .parse(req.body);
      res.json(await clock(ctx, actor(req), body.employeeId, body.pin));
    }),
  );

  // ── holidays
  r.get(
    '/holidays',
    ...viewAtt,
    asyncHandler(async (req, res) => {
      const { year } = z.object({ year: z.string().regex(/^\d{4}$/) }).parse(req.query);
      res.json({ items: await listHolidays(ctx, req.branchId!, year) });
    }),
  );
  r.post(
    '/holidays',
    ...markAtt,
    asyncHandler(async (req, res) => {
      const b = z
        .object({ date: isoDate, name: z.string().trim().min(1).max(80) })
        .strict()
        .parse(req.body);
      res.status(201).json(await addHoliday(ctx, actor(req), b.date, b.name));
    }),
  );
  r.delete(
    '/holidays/:id',
    ...markAtt,
    asyncHandler(async (req, res) => {
      await removeHoliday(ctx, actor(req), idParam.parse(req.params).id);
      res.status(204).end();
    }),
  );

  return r;
}

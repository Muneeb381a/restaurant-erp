import {
  ATTENDANCE_STATUSES,
  autoStatus,
  daysBetween,
  lateMinutes as lateMin,
  monthDays,
  overtimeMinutes as overtimeMin,
  summarizeMonth,
  workedMinutes as workedMin,
  type AttendanceStatus,
  type DayRecord,
} from '@erp/domain';
import { sql } from 'kysely';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';

/** Who is acting, for audit rows. */
export interface Actor {
  branchId: string;
  userId: string;
  deviceId?: string | null | undefined;
  ip?: string | undefined;
}

const act = (a: Actor) => ({
  branchId: a.branchId,
  userId: a.userId,
  deviceId: a.deviceId ?? null,
  ip: a.ip ?? null,
});

// ───────────────────────────── settings and time ─────────────────────────────

export interface HrSettings {
  /** minutes after the shift start before someone counts as late */
  lateGraceMinutes: number;
  /** minutes after the shift end before time counts as overtime */
  overtimeAfterMinutes: number;
}

export async function hrSettings(q: Queryable, branchId: string): Promise<HrSettings> {
  const rows = await q
    .selectFrom('settings')
    .select(['key', 'value'])
    .where('branch_id', '=', branchId)
    .where('key', 'in', ['hr.late_grace_minutes', 'hr.overtime_after_minutes'])
    .execute();
  const num = (key: string, dflt: number): number => {
    const v = rows.find((r) => r.key === key)?.value;
    return typeof v === 'number' ? v : dflt;
  };
  return {
    lateGraceMinutes: num('hr.late_grace_minutes', 10),
    overtimeAfterMinutes: num('hr.overtime_after_minutes', 30),
  };
}

async function branchTimezone(q: Queryable, branchId: string): Promise<string> {
  const b = await q
    .selectFrom('branches')
    .select('timezone')
    .where('id', '=', branchId)
    .executeTakeFirstOrThrow();
  return b.timezone;
}

/** The calendar date and the minutes after midnight of a moment, on a clock in a given time zone. */
export function localParts(at: Date, tz: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** Minutes after midnight of the WORK date, so a night shift's morning is 24:00 and later. */
export function minutesFromWorkDate(at: Date, workDate: string, tz: string): number {
  const p = localParts(at, tz);
  return (daysBetween(workDate, p.date) - 1) * 1440 + p.minutes;
}

const toMin = (t: string | null): number | null => {
  if (!t) return null;
  const [h, m] = t.split(':');
  return Number(h) * 60 + Number(m);
};

// ───────────────────────────────── employees ─────────────────────────────────

export const DEPARTMENTS = [
  'KITCHEN',
  'FLOOR',
  'COUNTER',
  'DELIVERY',
  'STORE',
  'ADMIN',
  'OTHER',
] as const;

export interface EmployeeInput {
  code?: string | undefined;
  fullName: string;
  fullNameUr?: string | null | undefined;
  phone?: string | null | undefined;
  cnic?: string | null | undefined;
  address?: string | null | undefined;
  emergencyContact?: string | null | undefined;
  designation?: string | undefined;
  department?: (typeof DEPARTMENTS)[number] | undefined;
  joinDate: string;
  leftDate?: string | null | undefined;
  status?: 'ACTIVE' | 'ON_NOTICE' | 'LEFT' | undefined;
  payType?: 'MONTHLY' | 'DAILY' | 'HOURLY' | undefined;
  basePayPaisa?: number | undefined;
  payFrequency?: 'MONTHLY' | 'WEEKLY' | 'DAILY' | undefined;
  weeklyOff?: number[] | undefined;
  shiftStart?: string | null | undefined;
  shiftEnd?: string | null | undefined;
  payoutMethod?: 'CASH' | 'JAZZCASH' | 'EASYPAISA' | 'BANK' | null | undefined;
  payoutAccount?: string | null | undefined;
  userId?: string | null | undefined;
  notes?: string | null | undefined;
}

type EmployeeRow = {
  id: string;
  code: string;
  full_name: string;
  full_name_ur: string | null;
  phone: string | null;
  cnic: string | null;
  address: string | null;
  emergency_contact: string | null;
  designation: string;
  department: string;
  join_date: string;
  left_date: string | null;
  status: string;
  pay_type: string;
  base_pay_paisa: number;
  pay_frequency: string;
  weekly_off: number[];
  shift_start: string | null;
  shift_end: string | null;
  payout_method: string | null;
  payout_account: string | null;
  user_id: string | null;
  pin_hash: string | null;
  notes: string | null;
};

const hhmm = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

/** What the app sees: never the PIN hash; personal fields only when the caller may see them. */
export function presentEmployee(e: EmployeeRow, opts: { personal: boolean }) {
  return {
    id: e.id,
    code: e.code,
    fullName: e.full_name,
    fullNameUr: e.full_name_ur,
    phone: e.phone,
    cnic: opts.personal ? e.cnic : null,
    address: opts.personal ? e.address : null,
    emergencyContact: opts.personal ? e.emergency_contact : null,
    designation: e.designation,
    department: e.department,
    joinDate: e.join_date,
    leftDate: e.left_date,
    status: e.status,
    payType: e.pay_type,
    basePayPaisa: e.base_pay_paisa,
    payFrequency: e.pay_frequency,
    weeklyOff: e.weekly_off,
    shiftStart: hhmm(e.shift_start),
    shiftEnd: hhmm(e.shift_end),
    payoutMethod: e.payout_method,
    payoutAccount: e.payout_account,
    userId: e.user_id,
    hasPin: !!e.pin_hash,
    notes: e.notes,
  };
}

export async function listEmployees(
  ctx: AppContext,
  branchId: string,
  opts: { status?: string | undefined; q?: string | undefined } = {},
): Promise<EmployeeRow[]> {
  let q = ctx.db.selectFrom('employees').selectAll().where('branch_id', '=', branchId);
  if (opts.status === 'CURRENT') q = q.where('status', '!=', 'LEFT');
  else if (opts.status) q = q.where('status', '=', opts.status);
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim().replace(/[%_]/g, '')}%`;
    q = q.where((eb) =>
      eb.or([
        eb('full_name', 'ilike', like),
        eb('code', 'ilike', like),
        eb('phone', 'ilike', like),
      ]),
    );
  }
  return (await q.orderBy('code').execute()) as unknown as EmployeeRow[];
}

export async function getEmployee(
  q: Queryable,
  branchId: string,
  id: string,
  lock = false,
): Promise<EmployeeRow> {
  let query = q
    .selectFrom('employees')
    .selectAll()
    .where('id', '=', id)
    .where('branch_id', '=', branchId);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'employee not found');
  return row as unknown as EmployeeRow;
}

async function nextCode(q: Queryable, branchId: string): Promise<string> {
  const rows = await q
    .selectFrom('employees')
    .select('code')
    .where('branch_id', '=', branchId)
    .execute();
  const max = rows.reduce((m, r) => {
    const n = /^E(\d+)$/.exec(r.code)?.[1];
    return n ? Math.max(m, Number(n)) : m;
  }, 0);
  return `E${String(max + 1).padStart(3, '0')}`;
}

const isUnique = (e: unknown): boolean => (e as { code?: string }).code === '23505';

function checkShape(i: Partial<EmployeeInput>, joinDate?: string | undefined): void {
  if (
    (i.shiftStart === undefined) !== (i.shiftEnd === undefined) &&
    (i.shiftStart ?? i.shiftEnd) !== undefined
  ) {
    if ((i.shiftStart === null) !== (i.shiftEnd === null))
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'Give both the start and the end of the usual hours, or neither',
      );
  }
  if (i.status === 'LEFT' && !i.leftDate)
    throw new AppError(400, 'VALIDATION_FAILED', 'Say the day they left');
  if (i.leftDate && joinDate && i.leftDate < joinDate)
    throw new AppError(400, 'VALIDATION_FAILED', 'They cannot leave before they joined');
}

export function createEmployee(ctx: AppContext, a: Actor, input: EmployeeInput) {
  return withTx(ctx.db, async (trx) => {
    checkShape(input, input.joinDate);
    const code = input.code?.trim() || (await nextCode(trx, a.branchId));
    try {
      const row = await trx
        .insertInto('employees')
        .values({
          branch_id: a.branchId,
          code,
          full_name: input.fullName,
          full_name_ur: input.fullNameUr ?? null,
          phone: input.phone ?? null,
          cnic: input.cnic ?? null,
          address: input.address ?? null,
          emergency_contact: input.emergencyContact ?? null,
          designation: input.designation ?? '',
          department: input.department ?? 'OTHER',
          join_date: input.joinDate,
          left_date: input.leftDate ?? null,
          status: input.status ?? 'ACTIVE',
          pay_type: input.payType ?? 'MONTHLY',
          base_pay_paisa: input.basePayPaisa ?? 0,
          pay_frequency: input.payFrequency ?? 'MONTHLY',
          weekly_off: input.weeklyOff ?? [],
          shift_start: input.shiftStart ?? null,
          shift_end: input.shiftEnd ?? null,
          payout_method: input.payoutMethod ?? null,
          payout_account: input.payoutAccount ?? null,
          user_id: input.userId ?? null,
          notes: input.notes ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        ...act(a),
        action: 'EMPLOYEE_CREATE',
        entity: 'employee',
        entityId: row.id,
        after: {
          code: row.code,
          name: row.full_name,
          payType: row.pay_type,
          basePayPaisa: row.base_pay_paisa,
        },
      });
      return row as unknown as EmployeeRow;
    } catch (e) {
      if (isUnique(e))
        throw new AppError(
          409,
          'EMPLOYEE_CODE_TAKEN',
          'That staff number (or linked sign-in) is already used',
        );
      throw e;
    }
  });
}

export function updateEmployee(
  ctx: AppContext,
  a: Actor,
  id: string,
  input: Partial<EmployeeInput>,
) {
  return withTx(ctx.db, async (trx) => {
    const before = await getEmployee(trx, a.branchId, id, true);
    checkShape(input, input.joinDate ?? before.join_date);
    const set: Record<string, unknown> = {};
    const map: [keyof EmployeeInput, string][] = [
      ['code', 'code'],
      ['fullName', 'full_name'],
      ['fullNameUr', 'full_name_ur'],
      ['phone', 'phone'],
      ['cnic', 'cnic'],
      ['address', 'address'],
      ['emergencyContact', 'emergency_contact'],
      ['designation', 'designation'],
      ['department', 'department'],
      ['joinDate', 'join_date'],
      ['leftDate', 'left_date'],
      ['status', 'status'],
      ['payType', 'pay_type'],
      ['basePayPaisa', 'base_pay_paisa'],
      ['payFrequency', 'pay_frequency'],
      ['weeklyOff', 'weekly_off'],
      ['shiftStart', 'shift_start'],
      ['shiftEnd', 'shift_end'],
      ['payoutMethod', 'payout_method'],
      ['payoutAccount', 'payout_account'],
      ['userId', 'user_id'],
      ['notes', 'notes'],
    ];
    for (const [k, col] of map) if (input[k] !== undefined) set[col] = input[k];
    // coming back (status ACTIVE) clears the day they left
    if (input.status && input.status !== 'LEFT' && input.leftDate === undefined)
      set.left_date = null;
    try {
      const row = await trx
        .updateTable('employees')
        .set(set as never)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const payChanged =
        row.base_pay_paisa !== before.base_pay_paisa || row.pay_type !== before.pay_type;
      await writeAudit(trx, {
        ...act(a),
        action: payChanged ? 'EMPLOYEE_PAY_CHANGE' : 'EMPLOYEE_UPDATE',
        entity: 'employee',
        entityId: id,
        before: {
          name: before.full_name,
          status: before.status,
          payType: before.pay_type,
          basePayPaisa: before.base_pay_paisa,
        },
        after: {
          name: row.full_name,
          status: row.status,
          payType: row.pay_type,
          basePayPaisa: row.base_pay_paisa,
        },
      });
      return row as unknown as EmployeeRow;
    } catch (e) {
      if (isUnique(e))
        throw new AppError(
          409,
          'EMPLOYEE_CODE_TAKEN',
          'That staff number (or linked sign-in) is already used',
        );
      throw e;
    }
  });
}

export function setEmployeePin(ctx: AppContext, a: Actor, id: string, pin: string | null) {
  return withTx(ctx.db, async (trx) => {
    await getEmployee(trx, a.branchId, id, true);
    const hash = pin ? await ctx.hasher.hash(pin) : null;
    await trx
      .updateTable('employees')
      .set({ pin_hash: hash, pin_failed: 0, pin_locked_until: null })
      .where('id', '=', id)
      .execute();
    await writeAudit(trx, {
      ...act(a),
      action: pin ? 'EMPLOYEE_PIN_SET' : 'EMPLOYEE_PIN_CLEAR',
      entity: 'employee',
      entityId: id,
    });
  });
}

// ───────────────────────────────── attendance ─────────────────────────────────

export interface MarkInput {
  status: AttendanceStatus;
  /** local clock time "HH:MM" on the work date (or the next morning for a night shift: use clockOutNextDay) */
  clockIn?: string | null | undefined;
  clockOut?: string | null | undefined;
  clockOutNextDay?: boolean | undefined;
  note?: string | null | undefined;
}

type AttendanceRow = {
  id: string;
  employee_id: string;
  work_date: string;
  status: string;
  clock_in: Date | null;
  clock_out: Date | null;
  worked_minutes: number | null;
  late_minutes: number;
  overtime_minutes: number;
  source: string;
  note: string | null;
};

const presentAttendance = (r: AttendanceRow | undefined | null) =>
  r
    ? {
        status: r.status,
        clockIn: r.clock_in,
        clockOut: r.clock_out,
        workedMinutes: r.worked_minutes,
        lateMinutes: r.late_minutes,
        overtimeMinutes: r.overtime_minutes,
        source: r.source,
        note: r.note,
      }
    : null;

const employedOn = (e: Pick<EmployeeRow, 'join_date' | 'left_date'>, date: string): boolean =>
  e.join_date <= date && (e.left_date === null || e.left_date >= date);

async function holidaySet(
  q: Queryable,
  branchId: string,
  from: string,
  to: string,
): Promise<Set<string>> {
  const rows = await q
    .selectFrom('holidays')
    .select('holiday_date')
    .where('branch_id', '=', branchId)
    .where('holiday_date', '>=', from)
    .where('holiday_date', '<=', to)
    .execute();
  return new Set(rows.map((r) => r.holiday_date));
}

/** Local "HH:MM" on a work date, as a moment (the branch's time zone decides what that moment is). */
async function moment(
  q: Queryable,
  date: string,
  time: string,
  tz: string,
  nextDay: boolean,
): Promise<Date> {
  const r = await sql<{
    t: Date;
  }>`select ((${date}::date + ${nextDay ? 1 : 0}::int + ${time}::time) at time zone ${tz}) as t`.execute(
    q,
  );
  return new Date(r.rows[0]!.t);
}

/** Late and overtime minutes of one day, from the clock times and the person's usual hours. */
function dayFigures(
  e: Pick<EmployeeRow, 'shift_start' | 'shift_end'>,
  workDate: string,
  tz: string,
  s: HrSettings,
  clockIn: Date | null,
  clockOut: Date | null,
): { late: number; overtime: number; worked: number | null } {
  const start = toMin(e.shift_start);
  const end = toMin(e.shift_end);
  const worked = clockIn && clockOut ? workedMin(clockIn.getTime(), clockOut.getTime()) : null;
  if (start === null || end === null) return { late: 0, overtime: 0, worked };
  const shift = { startMin: start, endMin: end };
  const late = clockIn
    ? lateMin(shift, minutesFromWorkDate(clockIn, workDate, tz), s.lateGraceMinutes)
    : 0;
  const overtime = clockOut
    ? overtimeMin(shift, minutesFromWorkDate(clockOut, workDate, tz), s.overtimeAfterMinutes)
    : 0;
  return { late, overtime, worked };
}

/** The sheet for one day: everyone employed that day, with what is marked (or what the calendar says). */
export async function attendanceSheet(ctx: AppContext, branchId: string, date: string) {
  const [emps, recs, holidays] = await Promise.all([
    ctx.db
      .selectFrom('employees')
      .selectAll()
      .where('branch_id', '=', branchId)
      .where('join_date', '<=', date)
      .where((eb) => eb.or([eb('left_date', 'is', null), eb('left_date', '>=', date)]))
      .orderBy('code')
      .execute(),
    ctx.db
      .selectFrom('attendance')
      .selectAll()
      .where('branch_id', '=', branchId)
      .where('work_date', '=', date)
      .execute(),
    holidaySet(ctx.db, branchId, date, date),
  ]);
  return emps.map((e) => {
    const rec = recs.find((r) => r.employee_id === e.id) as AttendanceRow | undefined;
    return {
      employee: {
        id: e.id,
        code: e.code,
        fullName: e.full_name,
        designation: e.designation,
        department: e.department,
        shiftStart: hhmm(e.shift_start),
        shiftEnd: hhmm(e.shift_end),
      },
      record: presentAttendance(rec),
      calendar: autoStatus(date, e.weekly_off, holidays),
    };
  });
}

/** Mark (or correct) one person's day. Every change is audited with what it was before. */
export function markAttendance(
  ctx: AppContext,
  a: Actor,
  employeeId: string,
  date: string,
  input: MarkInput,
) {
  return withTx(ctx.db, async (trx) => {
    const emp = await getEmployee(trx, a.branchId, employeeId, true);
    if (!employedOn(emp, date))
      throw new AppError(409, 'NOT_EMPLOYED_ON_DATE', 'They were not employed on that day');
    const tz = await branchTimezone(trx, a.branchId);
    const settings = await hrSettings(trx, a.branchId);
    const working = input.status === 'PRESENT' || input.status === 'HALF_DAY';
    if (!working && (input.clockIn || input.clockOut))
      throw new AppError(400, 'VALIDATION_FAILED', 'Clock times only go with a day they worked');
    if (input.clockOut && !input.clockIn)
      throw new AppError(400, 'VALIDATION_FAILED', 'Give the time they came in as well');

    const clockIn = input.clockIn ? await moment(trx, date, input.clockIn, tz, false) : null;
    const clockOut = input.clockOut
      ? await moment(trx, date, input.clockOut, tz, input.clockOutNextDay ?? false)
      : null;
    if (clockIn && clockOut && clockOut < clockIn)
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'They cannot leave before they came (a night shift ends the next morning)',
      );
    const f = working
      ? dayFigures(emp, date, tz, settings, clockIn, clockOut)
      : { late: 0, overtime: 0, worked: null };

    const before = await trx
      .selectFrom('attendance')
      .selectAll()
      .where('employee_id', '=', employeeId)
      .where('work_date', '=', date)
      .forUpdate()
      .executeTakeFirst();
    const row = await trx
      .insertInto('attendance')
      .values({
        branch_id: a.branchId,
        employee_id: employeeId,
        work_date: date,
        status: input.status,
        clock_in: clockIn,
        clock_out: clockOut,
        worked_minutes: f.worked,
        late_minutes: f.late,
        overtime_minutes: f.overtime,
        source: 'MANUAL',
        note: input.note ?? null,
        marked_by: a.userId,
      })
      .onConflict((oc) =>
        oc.columns(['employee_id', 'work_date']).doUpdateSet({
          status: input.status,
          clock_in: clockIn,
          clock_out: clockOut,
          worked_minutes: f.worked,
          late_minutes: f.late,
          overtime_minutes: f.overtime,
          source: 'MANUAL',
          note: input.note ?? null,
          marked_by: a.userId,
          updated_at: ctx.clock.now(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      ...act(a),
      action: before ? 'ATTENDANCE_CHANGE' : 'ATTENDANCE_MARK',
      entity: 'attendance',
      entityId: row.id,
      before: before
        ? {
            status: before.status,
            lateMinutes: before.late_minutes,
            overtimeMinutes: before.overtime_minutes,
          }
        : undefined,
      after: {
        employee: emp.code,
        date,
        status: row.status,
        lateMinutes: row.late_minutes,
        overtimeMinutes: row.overtime_minutes,
      },
    });
    return presentAttendance(row as unknown as AttendanceRow)!;
  });
}

/** "Everyone is here today": marks the people who have nothing marked yet (never overwrites). */
export function markMany(
  ctx: AppContext,
  a: Actor,
  date: string,
  status: AttendanceStatus,
  employeeIds: string[],
) {
  return withTx(ctx.db, async (trx) => {
    const emps = await trx
      .selectFrom('employees')
      .selectAll()
      .where('branch_id', '=', a.branchId)
      .where('id', 'in', employeeIds)
      .execute();
    const done = await trx
      .selectFrom('attendance')
      .select('employee_id')
      .where('work_date', '=', date)
      .where('employee_id', 'in', employeeIds)
      .execute();
    const have = new Set(done.map((d) => d.employee_id));
    let marked = 0;
    for (const e of emps) {
      if (have.has(e.id) || !employedOn(e as unknown as EmployeeRow, date)) continue;
      await trx
        .insertInto('attendance')
        .values({
          branch_id: a.branchId,
          employee_id: e.id,
          work_date: date,
          status,
          source: 'MANUAL',
          marked_by: a.userId,
        })
        .execute();
      marked++;
    }
    if (marked > 0)
      await writeAudit(trx, {
        ...act(a),
        action: 'ATTENDANCE_MARK_MANY',
        entity: 'attendance',
        after: { date, status, count: marked },
      });
    return { marked };
  });
}

// ───────────────────────────── the clock-in / clock-out screen ─────────────────────────────

const MAX_PIN_TRIES = 5;
const LOCK_MS = 5 * 60_000;
/** A clock-in older than this is not an open shift any more (they forgot to clock out). */
const OPEN_SHIFT_MAX_MS = 20 * 3_600_000;

/** Names for the clock screen: only people who have a PIN, and whether they are in right now. */
export async function clockList(ctx: AppContext, branchId: string) {
  const now = ctx.clock.now();
  const emps = await ctx.db
    .selectFrom('employees')
    .select(['id', 'code', 'full_name', 'designation'])
    .where('branch_id', '=', branchId)
    .where('status', '!=', 'LEFT')
    .where('pin_hash', 'is not', null)
    .orderBy('full_name')
    .execute();
  const open = await ctx.db
    .selectFrom('attendance')
    .select(['employee_id', 'clock_in'])
    .where('branch_id', '=', branchId)
    .where('clock_in', 'is not', null)
    .where('clock_out', 'is', null)
    .where('clock_in', '>', new Date(now.getTime() - OPEN_SHIFT_MAX_MS))
    .execute();
  const inSet = new Map(open.map((o) => [o.employee_id, o.clock_in]));
  return emps.map((e) => ({
    id: e.id,
    code: e.code,
    fullName: e.full_name,
    designation: e.designation,
    state: inSet.has(e.id) ? 'IN' : 'OUT',
    since: inSet.get(e.id) ?? null,
  }));
}

/**
 * The person taps their name and types their own PIN. If they are clocked in, this clocks them out;
 * otherwise it clocks them in for today. Five wrong PINs lock that person for five minutes.
 */
export async function clock(ctx: AppContext, a: Actor, employeeId: string, pin: string) {
  const out = await withTx(ctx.db, async (trx) => {
    const emp = await getEmployee(trx, a.branchId, employeeId, true);
    const now = ctx.clock.now();
    if (emp.status === 'LEFT')
      throw new AppError(409, 'NOT_EMPLOYED_ON_DATE', 'This person has left');
    const locked = await trx
      .selectFrom('employees')
      .select('pin_locked_until')
      .where('id', '=', employeeId)
      .executeTakeFirstOrThrow();
    if (locked.pin_locked_until && locked.pin_locked_until > now)
      throw new AppError(
        429,
        'PIN_LOCKED',
        'Too many wrong PINs. Try again in a few minutes, or ask the manager.',
      );
    const ok = emp.pin_hash ? await ctx.hasher.verify(emp.pin_hash, pin) : false;
    if (!ok) {
      const failed =
        (
          await trx
            .selectFrom('employees')
            .select('pin_failed')
            .where('id', '=', employeeId)
            .executeTakeFirstOrThrow()
        ).pin_failed + 1;
      await trx
        .updateTable('employees')
        .set({
          pin_failed: failed >= MAX_PIN_TRIES ? 0 : failed,
          pin_locked_until: failed >= MAX_PIN_TRIES ? new Date(now.getTime() + LOCK_MS) : null,
        })
        .where('id', '=', employeeId)
        .execute();
      // committed first, thrown after: the wrong try must count towards the lock
      return { wrong: failed } as const;
    }
    await trx
      .updateTable('employees')
      .set({ pin_failed: 0, pin_locked_until: null })
      .where('id', '=', employeeId)
      .execute();

    const tz = await branchTimezone(trx, a.branchId);
    const settings = await hrSettings(trx, a.branchId);
    const open = await trx
      .selectFrom('attendance')
      .selectAll()
      .where('employee_id', '=', employeeId)
      .where('clock_in', 'is not', null)
      .where('clock_out', 'is', null)
      .where('clock_in', '>', new Date(now.getTime() - OPEN_SHIFT_MAX_MS))
      .orderBy('clock_in', 'desc')
      .forUpdate()
      .executeTakeFirst();

    if (open) {
      const f = dayFigures(emp, open.work_date, tz, settings, open.clock_in, now);
      await trx
        .updateTable('attendance')
        .set({
          clock_out: now,
          worked_minutes: f.worked,
          overtime_minutes: f.overtime,
          updated_at: now,
        })
        .where('id', '=', open.id)
        .execute();
      await writeAudit(trx, {
        ...act(a),
        action: 'ATTENDANCE_CLOCK_OUT',
        entity: 'attendance',
        entityId: open.id,
        after: { employee: emp.code },
      });
      return {
        wrong: 0,
        action: 'OUT' as const,
        employee: emp.full_name,
        at: now,
        workedMinutes: f.worked,
        lateMinutes: open.late_minutes,
      };
    }

    const today = localParts(now, tz).date;
    const existing = await trx
      .selectFrom('attendance')
      .selectAll()
      .where('employee_id', '=', employeeId)
      .where('work_date', '=', today)
      .forUpdate()
      .executeTakeFirst();
    if (existing && existing.clock_out)
      throw new AppError(
        409,
        'ALREADY_CLOCKED_OUT',
        'Already clocked out today. Ask the manager to correct the day.',
      );
    const f = dayFigures(emp, today, tz, settings, now, null);
    // an ABSENT / LEAVE mark made earlier is replaced: they did turn up
    const row = await trx
      .insertInto('attendance')
      .values({
        branch_id: a.branchId,
        employee_id: employeeId,
        work_date: today,
        status: 'PRESENT',
        clock_in: now,
        late_minutes: f.late,
        source: 'KIOSK',
      })
      .onConflict((oc) =>
        oc.columns(['employee_id', 'work_date']).doUpdateSet({
          status: 'PRESENT',
          clock_in: now,
          late_minutes: f.late,
          source: 'KIOSK',
          updated_at: now,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      ...act(a),
      action: 'ATTENDANCE_CLOCK_IN',
      entity: 'attendance',
      entityId: row.id,
      after: { employee: emp.code, lateMinutes: f.late },
    });
    return {
      wrong: 0,
      action: 'IN' as const,
      employee: emp.full_name,
      at: now,
      workedMinutes: null,
      lateMinutes: f.late,
    };
  });
  if (out.wrong > 0) throw new PinWrong(out.wrong);
  if (!('action' in out)) throw new AppError(500, 'INTERNAL_ERROR', 'clock failed');
  return out;
}

/** A wrong PIN is an answer, but the failed-try counter must be committed, so it is thrown after the work is done. */
export class PinWrong extends AppError {
  constructor(readonly tries: number) {
    super(400, 'PIN_WRONG', 'That PIN is not right.', {
      triesLeft: Math.max(0, MAX_PIN_TRIES - tries),
    });
  }
}

// ──────────────────────────────── the month ────────────────────────────────

export async function attendanceMonth(ctx: AppContext, branchId: string, month: string) {
  const days = monthDays(month);
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const [emps, recs, holidays] = await Promise.all([
    ctx.db
      .selectFrom('employees')
      .selectAll()
      .where('branch_id', '=', branchId)
      .where('join_date', '<=', last)
      .where((eb) => eb.or([eb('left_date', 'is', null), eb('left_date', '>=', first)]))
      .orderBy('code')
      .execute(),
    ctx.db
      .selectFrom('attendance')
      .selectAll()
      .where('branch_id', '=', branchId)
      .where('work_date', '>=', first)
      .where('work_date', '<=', last)
      .execute(),
    holidaySet(ctx.db, branchId, first, last),
  ]);
  return {
    month,
    days,
    holidays: [...holidays].sort(),
    employees: emps.map((e) => {
      const mine = recs.filter((r) => r.employee_id === e.id);
      const records: DayRecord[] = mine.map((r) => ({
        date: r.work_date,
        status: r.status as AttendanceStatus,
        lateMinutes: r.late_minutes,
        overtimeMinutes: r.overtime_minutes,
        workedMinutes: r.worked_minutes,
      }));
      const summary = summarizeMonth({
        month,
        records,
        weeklyOff: e.weekly_off,
        holidays,
        from: e.join_date,
        ...(e.left_date ? { to: e.left_date } : {}),
      });
      const statusOf = (d: string): string | null => {
        if (d < e.join_date || (e.left_date && d > e.left_date)) return null;
        return mine.find((r) => r.work_date === d)?.status ?? autoStatus(d, e.weekly_off, holidays);
      };
      return {
        id: e.id,
        code: e.code,
        fullName: e.full_name,
        designation: e.designation,
        days: days.map((d) => ({ date: d, status: statusOf(d) })),
        summary,
      };
    }),
  };
}

// ──────────────────────────────── holidays ────────────────────────────────

export async function listHolidays(ctx: AppContext, branchId: string, year: string) {
  return ctx.db
    .selectFrom('holidays')
    .select(['id', 'holiday_date', 'name'])
    .where('branch_id', '=', branchId)
    .where('holiday_date', '>=', `${year}-01-01`)
    .where('holiday_date', '<=', `${year}-12-31`)
    .orderBy('holiday_date')
    .execute();
}

export function addHoliday(ctx: AppContext, a: Actor, date: string, name: string) {
  return withTx(ctx.db, async (trx) => {
    try {
      const row = await trx
        .insertInto('holidays')
        .values({ branch_id: a.branchId, holiday_date: date, name })
        .returning(['id', 'holiday_date', 'name'])
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        ...act(a),
        action: 'HOLIDAY_ADD',
        entity: 'holiday',
        entityId: row.id,
        after: { date, name },
      });
      return row;
    } catch (e) {
      if (isUnique(e)) throw new AppError(409, 'HOLIDAY_EXISTS', 'That day is already a holiday');
      throw e;
    }
  });
}

export function removeHoliday(ctx: AppContext, a: Actor, id: string) {
  return withTx(ctx.db, async (trx) => {
    const row = await trx
      .deleteFrom('holidays')
      .where('id', '=', id)
      .where('branch_id', '=', a.branchId)
      .returning(['holiday_date', 'name'])
      .executeTakeFirst();
    if (!row) throw new AppError(404, 'NOT_FOUND', 'holiday not found');
    await writeAudit(trx, {
      ...act(a),
      action: 'HOLIDAY_REMOVE',
      entity: 'holiday',
      entityId: id,
      before: { date: row.holiday_date, name: row.name },
    });
  });
}

export { ATTENDANCE_STATUSES };

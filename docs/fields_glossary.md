# Field glossary

## The daily files

The telematics provider sends one file every morning at 4am. You'll find them in `data/incoming/`. The date in the file name is the delivery date. Each file holds the **previous day's** events, from 00:00 to 23:59.

For example, `2026-09-08_DailyTelemetryData.csv` arrives on Tuesday 8 September and holds Monday 7 September.

Each row is one event recorded by a machine's telematics unit. Times are local time (SAST).

## Columns

| Column | What it means | Type and unit |
| --- | --- | --- |
| `DateAndTime` | When the unit recorded the event. | ISO 8601 date and time, for example `2026-09-07T06:02:30` |
| `RefNo.` | The machine's reference number. Matches `RefNo.` in `data/machine_list.csv`. | Text |
| `BranchName` | The branch the machine was at, written as `Ridgeback <branch>`. The machine list uses the branch name without the `Ridgeback ` prefix. | Text |
| `TxFlagStrings` | The type of event. See the list below. | Text |
| `RunHours` | Total time the motor has run since the unit was installed. It only goes up. The time a machine ran on a day is the change in this value across that day. | Whole number, seconds, cumulative |
| `DriverName`, `DriverSurname` | The driver logged on to the machine at the time of the event. Blank until a driver logs on, for example on `Power Up` rows. | Text |

To convert seconds to hours, divide by 3,600.

## Event types (`TxFlagStrings`)

| Value | What it means |
| --- | --- |
| `Power Up` | The machine was switched on. |
| `Driver Change` | A driver logged on to the machine. |
| `Unit (Time/GPS) Update Level` | A routine update, sent every 30 minutes while the machine is on. It is not an event, so don't count it as one. Its `RunHours` reading is valid. |
| `Impact` | The machine hit something. |
| `Harsh Braking` | The machine braked too hard. |
| `Harsh Acceleration` | The machine accelerated too hard. |
| `Speeding` | The machine went over the speed limit. |
| `Excess Idle` | The machine was on but not moving for too long. |

## Machine list (`data/machine_list.csv`)

| Column | What it means |
| --- | --- |
| `RefNo.` | The machine's reference number. |
| `BranchName` | The branch the machine is assigned to. |
| `MachineType` | `Forklift`, `Reach Truck` or `PPT` (pallet truck). |

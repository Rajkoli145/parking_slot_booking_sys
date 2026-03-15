const express = require("express");
const { graphqlHTTP } = require('express-graphql'); // this is the middle-ware or the bridge btn the express and graphql . it take the graphql schema and handles all the incoming GraphQL requests automatically 
const { graphbuild, buildSchema } = require('graphql'); //lets you write your schema in plain text (called SDL — Schema Definition Language) like this: type Query { message: String } 
const { v4: uuid4 } = require('uuid'); // is used to generate random unique ids for our data 

const app = express()

//  1. SCHEMA (TypeDefs)
const schema = buildSchema(`
    enum SlotStatus { avialable occupied reserved}
    enum BookingStatus { active completed cancelled}
    enum PaymentStatus { pending paid failed}
    
    type User {
    id: ID!
    name: String!
    email: String!
    phone: String!
    }

    type ParkingLot {
    id:ID!
    name: String!
    location: String!
    total_slot:Int!
    slots : [ParkingSlot] 
    }

    type ParkingSlot{
    id: ID!
    lot_id: ID!
    slot_number: String!
    Status: SlotStatus!
    }

    type Booking{
    id: ID!
    slot_id: ID!
    User_id: ID!
    start_time: String!
    end_time: String!
    status: BookingStatus!
    hours: Float
    slot : ParkingSlot
    payment: Payment
    }
    
    type Payment{
    id: ID!
    Booking_id: ID!   
    amount: Float!    
    status: PaymentStatus!
    }

    input CreateUserInput {
    name:String!
    email:String!
    phone:String!
    }

    input CreateParkingLotInput {
    name: String!
    location: String!
    total_slots: Int!
    }

    input CreateBookingInput {
    slotId: ID!
    UserId: ID!
    startTime: String!
    endTime: String!
    }
    

    type Query {
    getUsers: [User]
    getUser(id: ID!): User
    getParkingLots: [ParkingLot]
    getParkingLot(id: ID!): ParkingLot
    getAvailableSlots(lotId: ID!): [ParkingSlot]
    getBooking(id: ID!): Booking
    getBookingsByUser(userId: ID!): [Booking]
    getAllPayments: [Payment]
  }


    type Mutation {
    createUser(input: CreateUserInput!): User
    createParkingLot(input: CreateParkingLotInput!): ParkingLot
    createBooking(input: CreateBookingInput!): Booking
    cancelBooking(id: ID!): Booking
    makePayment(BookingId: ID!): Payment

  }
`);


// 2. In memory database:
const db = {
    Users: [],
    ParkingLots: [],
    ParkingSlots: [],
    Bookings: [],
    Payments: []
};

// 3. Helper Functions :
// small reusable functions that do one job, making your main code cleaner, shorter and easier to maintain
const RATE_PER_HOUR = 50; // ₹50 per hour

function calcHours(start, end) {
    const diff = new Date(end) - new Date(start);
    return diff / (1000 * 60 * 60); // ms → hours
}

// Check conficts btn Booking slots
function hasTimeConflict(slotId, startTime, endTime, excludeBookingId = null) {
    return db.Bookings.some(b => {
        if (b.slot_id !== slotId) return false;
        if (b.status === 'cancelled') return false;
        if (excludeBookingId && b.id === excludeBookingId) return false;

        const newStart = new Date(startTime);
        const newEnd = new Date(endTime);
        const exStart = new Date(b.start_time);
        const exEnd = new Date(b.end_time);

        // Overlap check
        return newStart < exEnd && newEnd > exStart;
    });
}

// 4. Resolvers:
const root = {

    getUsers: () => db.Users,
    getUser: ({ id }) => db.Users.find(u => u.id === id),


    createUser: ({ input }) => {
        const User = { id: uuidv4(), ...input };
        db.Users.push(User);
        return User;
    },

    getParkingLots: () => db.parkingLots.map(lot => ({
        ...lot,
        slots: db.ParkingSlots.filter(s => s.lot_id === lot.id)
    })),

    createParkingLot: ({ input }) => {
        const lot = { id: uuidv4(), ...input };
        db.parkingLots.push(lot);

        // Auto-create slots for this lot
        for (let i = 1; i <= input.total_slots; i++) {
            db.ParkingSlots.push({
                id: uuidv4(),
                lot_id: lot.id,
                slot_number: `S${i}`,
                status: 'available'
            });
        }
        return { ...lot, slots: db.ParkingSlots.filter(s => s.lot_id === lot.id) };
    },
    // ── SLOTS ─────────────────────────────────────
    getAvailableSlots: ({ lotId }) =>
        db.ParkingSlots.filter(s => s.lot_id === lotId && s.status === 'available'),

    // ── Booking ───────────────────────────────────
    getBooking: ({ id }) => {
        const Booking = db.Bookings.find(b => b.id === id);
        if (!Booking) throw new Error('Booking not found');
        return {
            ...Booking,
            hours: calcHours(Booking.start_time, Booking.end_time),
            slot: db.ParkingSlots.find(s => s.id === Booking.slot_id),
            Payment: db.Payments.find(p => p.Booking_id === Booking.id)
        };
    },
    createBooking: ({ input }) => {
        const { slotId, UserId, startTime, endTime } = input;

        // 1.  Validating slot exists
        const slot = db.ParkingSlots.find(s => s.id === slotId);
        if (!slot) throw new Error('Slot not found');

        // 2. Validting slot is available
        if (slot.status === 'occupied') throw new Error('Slot is occupied');

        // 3. Validating time conflict so no confict btn two Booking at same time
        if (hasTimeConflict(slotId, startTime, endTime)) {
            throw new Error('Time conflict: slot already booked in this time range');
        }
        // 4. Validting end time and start time
        if (new Date(endTime) <= new Date(startTime)) {
            throw new Error('End time must be after start time');
        }
        // 5. Create Booking
        const Booking = {
            id: uuidv4(),
            slot_id: slotId,
            User_id: UserId,
            start_time: startTime,
            end_time: endTime,
            status: 'active'
        };
        db.Bookings.push(Booking);

        // Mark slot as reserved
        slot.status = 'reserved';

        return {
            ...Booking,
            hours: calcHours(startTime, endTime),
            slot,
            Payment: null
        };
    },
    //  two main thing in cancel Booking 
    // 1 -> u can only cancel the active Booking not completed or cancelled one
    // 2 -> when cancelled the slot goes to avaliable so someone else can book it 
    cancelBooking: ({ id }) => {
        const Booking = db.Bookings.find(b => b.id === id);
        if (!Booking) throw new Error('Booking not found');
        if (Booking.status !== 'active') throw new Error('Only active Bookings can be cancelled');

        Booking.status = 'cancelled';

        // Free up the slot
        const slot = db.ParkingSlots.find(s => s.id === Booking.slot_id);
        if (slot) slot.status = 'available';

        return { ...Booking, slot };
    },

    getAllPayments: () => db.Payments,

    makePayment: ({ BookingId }) => {
        const Booking = db.Bookings.find(b => b.id === BookingId);
        if (!Booking) throw new Error('Booking not found');
        if (Booking.status !== 'active') throw new Error('Booking is not active');
        const existing = db.Payments.find(p => p.Booking_id === BookingId);
        if (existing) throw new Error('Payment already made for this Booking');

        const hours = calcHours(Booking.start_time, Booking.end_time);
        const amount = hours * RATE_PER_HOUR;

        const Payment = {
            id: uuidv4(),
            Booking_id: BookingId,
            amount: parseFloat(amount.toFixed(2)),
            status: 'paid'
        };
        db.Payments.push(Payment);

        // Update Booking to completed after Payment
        Booking.status = 'completed';

        // Free up the slot
        const slot = db.ParkingSlots.find(s => s.id === Booking.slot_id);
        if (slot) slot.status = 'available';

        return Payment;
    }
};

//  server setup:
app.use('/graphql', graphqlHTTP({
    schema,
    rootValue: root,
    graphiql: true
}));

app.listen(4000, () => {
    console.log('Server running at http://localhost:4000/graphql');
});



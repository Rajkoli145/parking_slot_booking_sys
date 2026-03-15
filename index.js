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
    
    type user {
    id: ID!
    name: String!
    email: String!
    phone: String!
    }

    type parkingLot {
    id:ID!
    name: String!
    location: String!
    total_slot:Int!
    slots : [parkingslot] 
    }

    type parkingSlot{
    id: ID!
    lot_id: ID!
    slot_number: String!
    Status: SlotStatus!
    }

    type booking{
    id: ID!
    slot_id: ID!
    user_id: ID!
    start_time: String!
    end_time: String!
    status: BookingStatus!
    hours: Float
    slot : ParkingSlot
    payment: Payment
    }
    
    type payment{
    id: ID!
    id: ID!
    booking_id: ID!   
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
    userId: ID!
    startTime: String!
    endTime: String!
    }
    

    type Query{
    getUsers : [user]
    getUser(id:ID!): user
    getParkingLots : [parkingLot]
    getParkingLot(id:ID!): parkingLot
    getBookings : [booking]
    getBooking(id:ID!): booking
    getPayments : [payment]
    getPayment(id:ID!): payment
    }


    type Mutation {
    createUser(input: CreateUserInput!): User
    createParkingLot(input: CreateParkingLotInput!): ParkingLot
    createBooking(input: CreateBookingInput!): Booking
    cancelBooking(id: ID!): Booking
    makePayment(bookingId: ID!): Payment

  }
`);


// 2. In memory database:
const db = {
    users: [],
    parkingLots: [],
    parkingSlots: [],
    bookings: [],
    payments: []
};

// 3. Helper Functions :
// small reusable functions that do one job, making your main code cleaner, shorter and easier to maintain
const RATE_PER_HOUR = 50; // ₹50 per hour

function calcHours(start, end) {
    const diff = new Date(end) - new Date(start);
    return diff / (1000 * 60 * 60); // ms → hours
}

// Check conficts btn booking slots
function hasTimeConflict(slotId, startTime, endTime, excludeBookingId = null) {
    return db.bookings.some(b => {
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

    getUsers: () => db.users,
    getUser: ({ id }) => db.users.find(u => u.id === id),


    createUser: ({ input }) => {
        const user = { id: uuidv4(), ...input };
        db.users.push(user);
        return user;
    },

    getParkingLots: () => db.parkingLots.map(lot => ({
        ...lot,
        slots: db.parkingSlots.filter(s => s.lot_id === lot.id)
    })),

    createParkingLot: ({ input }) => {
        const lot = { id: uuidv4(), ...input };
        db.parkingLots.push(lot);

        // Auto-create slots for this lot
        for (let i = 1; i <= input.total_slots; i++) {
            db.parkingSlots.push({
                id: uuidv4(),
                lot_id: lot.id,
                slot_number: `S${i}`,
                status: 'available'
            });
        }
        return { ...lot, slots: db.parkingSlots.filter(s => s.lot_id === lot.id) };
    },
    // ── SLOTS ─────────────────────────────────────
    getAvailableSlots: ({ lotId }) =>
        db.parkingSlots.filter(s => s.lot_id === lotId && s.status === 'available'),

    // ── BOOKING ───────────────────────────────────
    getBooking: ({ id }) => {
        const booking = db.bookings.find(b => b.id === id);
        if (!booking) throw new Error('Booking not found');
        return {
            ...booking,
            hours: calcHours(booking.start_time, booking.end_time),
            slot: db.parkingSlots.find(s => s.id === booking.slot_id),
            payment: db.payments.find(p => p.booking_id === booking.id)
        };
    },
    createBooking: ({ input }) => {
        const { slotId, userId, startTime, endTime } = input;

        // 1.  Validating slot exists
        const slot = db.parkingSlots.find(s => s.id === slotId);
        if (!slot) throw new Error('Slot not found');

        // 2. Validting slot is available
        if (slot.status === 'occupied') throw new Error('Slot is occupied');

        // 3. Validating time conflict so no confict btn two booking at same time
        if (hasTimeConflict(slotId, startTime, endTime)) {
            throw new Error('Time conflict: slot already booked in this time range');
        }
        // 4. Validting end time and start time
        if (new Date(endTime) <= new Date(startTime)) {
            throw new Error('End time must be after start time');
        }
        // 5. Create booking
        const booking = {
            id: uuidv4(),
            slot_id: slotId,
            user_id: userId,
            start_time: startTime,
            end_time: endTime,
            status: 'active'
        };
        db.bookings.push(booking);

        // Mark slot as reserved
        slot.status = 'reserved';

        return {
            ...booking,
            hours: calcHours(startTime, endTime),
            slot,
            payment: null
        };
    },
    //  two main thing in cancel booking 
    // 1 -> u can only cancel the active booking not completed or cancelled one
    // 2 -> when cancelled the slot goes to avaliable so someone else can book it 
    cancelBooking: ({ id }) => {
        const booking = db.bookings.find(b => b.id === id);
        if (!booking) throw new Error('Booking not found');
        if (booking.status !== 'active') throw new Error('Only active bookings can be cancelled');

        booking.status = 'cancelled';

        // Free up the slot
        const slot = db.parkingSlots.find(s => s.id === booking.slot_id);
        if (slot) slot.status = 'available';

        return { ...booking, slot };
    },

    getAllPayments: () => db.payments,

    makePayment: ({ bookingId }) => {
        const booking = db.bookings.find(b => b.id === bookingId);
        if (!booking) throw new Error('Booking not found');
        if (booking.status !== 'active') throw new Error('Booking is not active');
        const existing = db.payments.find(p => p.booking_id === bookingId);
        if (existing) throw new Error('Payment already made for this booking');

        const hours = calcHours(booking.start_time, booking.end_time);
        const amount = hours * RATE_PER_HOUR;

        const payment = {
            id: uuidv4(),
            booking_id: bookingId,
            amount: parseFloat(amount.toFixed(2)),
            status: 'paid'
        };
        db.payments.push(payment);

        // Update booking to completed after payment
        booking.status = 'completed';

        // Free up the slot
        const slot = db.parkingSlots.find(s => s.id === booking.slot_id);
        if (slot) slot.status = 'available';

        return payment;
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


